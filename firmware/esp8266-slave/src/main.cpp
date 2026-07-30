#include <Arduino.h>
#include <ArduinoJson.h>
#include <ESP8266HTTPClient.h>
#include <ESP8266WebServer.h>
#include <ESP8266WiFi.h>
#include <LittleFS.h>
#include <DHT.h>

constexpr char FIRMWARE_VERSION[] = "1.0.0";
constexpr char CONFIG_PATH[] = "/agrimind.json";
constexpr char SETUP_SSID[] = "Agrimind-Slave-Setup";
constexpr char SETUP_PASSWORD[] = "agrimind-setup";

constexpr uint8_t SOIL_PIN = A0;
constexpr uint8_t RELAY_PIN = D1;
constexpr uint8_t RESET_BUTTON_PIN = D5;
constexpr uint8_t DHT_PIN = D2;
constexpr uint8_t DHT_TYPE = DHT22;

constexpr bool RELAY_ACTIVE_LOW = true;
constexpr bool ENABLE_AUTOMATIC_PUMP = false;
constexpr int SOIL_RAW_DRY = 800;
constexpr int SOIL_RAW_WET = 350;
constexpr int PUMP_START_PERCENT = 30;
constexpr int PUMP_STOP_PERCENT = 50;
constexpr unsigned long TELEMETRY_INTERVAL_MS = 30000;
constexpr unsigned long WIFI_CONNECT_TIMEOUT_MS = 20000;
constexpr unsigned long RESET_HOLD_MS = 5000;

struct AgrimindConfig {
  String wifiSsid;
  String wifiPassword;
  String slaveId;
  String displayName;
  String claimToken;
  String apiToken;
  String orangePiUrls[4];
  uint8_t orangePiUrlCount = 0;
};

AgrimindConfig config;
ESP8266WebServer setupServer(80);
DHT dht(DHT_PIN, DHT_TYPE);
bool setupMode = false;
bool restartRequested = false;
bool pumpOn = false;
unsigned long restartAt = 0;
unsigned long lastTelemetryAt = 0;
unsigned long lastClaimAttemptAt = 0;
unsigned long resetPressedAt = 0;

void setPump(bool enabled) {
  pumpOn = enabled;
  const bool outputHigh = RELAY_ACTIVE_LOW ? !enabled : enabled;
  digitalWrite(RELAY_PIN, outputHigh ? HIGH : LOW);
}

void clearConfig() {
  LittleFS.remove(CONFIG_PATH);
  config = AgrimindConfig{};
}

bool saveConfig() {
  JsonDocument document;
  document["wifi_ssid"] = config.wifiSsid;
  document["wifi_password"] = config.wifiPassword;
  document["slave_id"] = config.slaveId;
  document["display_name"] = config.displayName;
  document["claim_token"] = config.claimToken;
  document["api_token"] = config.apiToken;
  JsonArray urls = document["orange_pi_urls"].to<JsonArray>();
  for (uint8_t index = 0; index < config.orangePiUrlCount; index++) urls.add(config.orangePiUrls[index]);
  File file = LittleFS.open(CONFIG_PATH, "w");
  if (!file) return false;
  const bool written = serializeJson(document, file) > 0;
  file.close();
  return written;
}

bool loadConfig() {
  if (!LittleFS.exists(CONFIG_PATH)) return false;
  File file = LittleFS.open(CONFIG_PATH, "r");
  if (!file) return false;
  JsonDocument document;
  const DeserializationError error = deserializeJson(document, file);
  file.close();
  if (error) return false;
  config.wifiSsid = document["wifi_ssid"] | "";
  config.wifiPassword = document["wifi_password"] | "";
  config.slaveId = document["slave_id"] | "";
  config.displayName = document["display_name"] | "";
  config.claimToken = document["claim_token"] | "";
  config.apiToken = document["api_token"] | "";
  config.orangePiUrlCount = 0;
  for (JsonVariant value : document["orange_pi_urls"].as<JsonArray>()) {
    if (config.orangePiUrlCount >= 4) break;
    String url = value.as<String>();
    while (url.endsWith("/")) url.remove(url.length() - 1);
    if (url.length()) config.orangePiUrls[config.orangePiUrlCount++] = url;
  }
  return config.wifiSsid.length() && config.slaveId.length() && config.orangePiUrlCount;
}

void sendJson(int code, const JsonDocument &document) {
  String body;
  serializeJson(document, body);
  setupServer.sendHeader("Access-Control-Allow-Origin", "*");
  setupServer.send(code, "application/json", body);
}

void startSetupPortal() {
  setupMode = true;
  setPump(false);
  WiFi.mode(WIFI_AP);
  WiFi.softAP(SETUP_SSID, SETUP_PASSWORD);
  Serial.printf("Setup hotspot: %s, IP: %s\n", SETUP_SSID, WiFi.softAPIP().toString().c_str());
  setupServer.on("/", HTTP_GET, []() {
    setupServer.send(200, "text/plain", "Agrimind ESP8266 setup is ready. Use the Agrimind mobile app.");
  });
  setupServer.on("/status", HTTP_GET, []() {
    JsonDocument response;
    response["ok"] = true;
    response["firmware_version"] = FIRMWARE_VERSION;
    response["chip_id"] = String(ESP.getChipId(), HEX);
    response["setup_ssid"] = SETUP_SSID;
    sendJson(200, response);
  });
  setupServer.on("/provision", HTTP_OPTIONS, []() {
    setupServer.sendHeader("Access-Control-Allow-Origin", "*");
    setupServer.sendHeader("Access-Control-Allow-Headers", "Content-Type");
    setupServer.send(204);
  });
  setupServer.on("/provision", HTTP_POST, []() {
    JsonDocument request;
    const DeserializationError error = deserializeJson(request, setupServer.arg("plain"));
    JsonDocument response;
    if (error) {
      response["ok"] = false;
      response["error"] = "Invalid JSON";
      return sendJson(400, response);
    }
    const String ssid = request["wifi_ssid"] | "";
    const String password = request["wifi_password"] | "";
    const String slaveId = request["slave_id"] | "";
    const String claimToken = request["claim_token"] | "";
    JsonArray urls = request["orange_pi_urls"].as<JsonArray>();
    if (!ssid.length() || password.length() < 8 || !slaveId.startsWith("slave-")
        || claimToken.length() < 32 || urls.size() == 0) {
      response["ok"] = false;
      response["error"] = "Missing or invalid provisioning values";
      return sendJson(400, response);
    }
    config = AgrimindConfig{};
    config.wifiSsid = ssid;
    config.wifiPassword = password;
    config.slaveId = slaveId;
    config.displayName = request["display_name"] | slaveId;
    config.claimToken = claimToken;
    for (JsonVariant value : urls) {
      if (config.orangePiUrlCount >= 4) break;
      String url = value.as<String>();
      while (url.endsWith("/")) url.remove(url.length() - 1);
      if (url.startsWith("http://") && url.length()) config.orangePiUrls[config.orangePiUrlCount++] = url;
    }
    if (!config.orangePiUrlCount || !saveConfig()) {
      response["ok"] = false;
      response["error"] = "Could not save configuration";
      return sendJson(500, response);
    }
    response["ok"] = true;
    response["message"] = "Configuration saved; ESP8266 is restarting";
    sendJson(200, response);
    restartRequested = true;
    restartAt = millis() + 1200;
  });
  setupServer.onNotFound([]() {
    JsonDocument response;
    response["ok"] = false;
    response["error"] = "Route not found";
    sendJson(404, response);
  });
  setupServer.begin();
}

bool connectToFarmWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);
  WiFi.begin(config.wifiSsid.c_str(), config.wifiPassword.c_str());
  Serial.printf("Connecting to Wi-Fi %s", config.wifiSsid.c_str());
  const unsigned long startedAt = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startedAt < WIFI_CONNECT_TIMEOUT_MS) {
    delay(250);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() != WL_CONNECTED) return false;
  Serial.printf("Wi-Fi connected, IP: %s\n", WiFi.localIP().toString().c_str());
  return true;
}

bool postJson(const String &url, const String &authorization, const JsonDocument &request,
              JsonDocument &responseDocument, int &statusCode) {
  WiFiClient client;
  HTTPClient http;
  if (!http.begin(client, url)) return false;
  http.addHeader("Content-Type", "application/json");
  if (authorization.length()) http.addHeader("Authorization", "Bearer " + authorization);
  String body;
  serializeJson(request, body);
  statusCode = http.POST(body);
  const String response = statusCode > 0 ? http.getString() : "";
  http.end();
  if (statusCode <= 0) return false;
  return !deserializeJson(responseDocument, response);
}

bool claimOrangePiToken() {
  if (config.apiToken.length()) return true;
  if (!config.claimToken.length()) return false;
  JsonDocument request;
  request["slave_id"] = config.slaveId;
  request["chip_id"] = String(ESP.getChipId(), HEX);
  request["claim_token"] = config.claimToken;
  request["firmware_version"] = FIRMWARE_VERSION;
  for (uint8_t index = 0; index < config.orangePiUrlCount; index++) {
    JsonDocument response;
    int statusCode = 0;
    const String url = config.orangePiUrls[index] + "/api/slaves/pairing/claim";
    if (!postJson(url, "", request, response, statusCode) || statusCode != 201) continue;
    const String token = response["credentials"]["api_token"] | "";
    if (!token.length()) continue;
    config.apiToken = token;
    config.claimToken = "";
    saveConfig();
    Serial.printf("Paired with Orange Pi as %s\n", config.slaveId.c_str());
    return true;
  }
  return false;
}

int soilMoisturePercent() {
  const int raw = analogRead(SOIL_PIN);
  const long percent = map(raw, SOIL_RAW_DRY, SOIL_RAW_WET, 0, 100);
  return constrain(percent, 0, 100);
}

void updatePump(int soilPercent) {
  if (!ENABLE_AUTOMATIC_PUMP) return setPump(false);
  if (!pumpOn && soilPercent <= PUMP_START_PERCENT) setPump(true);
  else if (pumpOn && soilPercent >= PUMP_STOP_PERCENT) setPump(false);
}

bool sendTelemetry() {
  if (!config.apiToken.length()) return false;
  const int soilPercent = soilMoisturePercent();
  updatePump(soilPercent);
  JsonDocument request;
  request["soil_moisture_percent"] = soilPercent;
  request["pump_on"] = pumpOn;
  request["sensor_on"] = true;
#if ENABLE_DHT_SENSOR
  const float humidity = dht.readHumidity();
  const float temperature = dht.readTemperature();
  if (isnan(humidity)) request["humidity_percent"] = nullptr;
  else request["humidity_percent"] = humidity;
  if (isnan(temperature)) request["temperature_c"] = nullptr;
  else request["temperature_c"] = temperature;
#else
  request["humidity_percent"] = nullptr;
  request["temperature_c"] = nullptr;
#endif
  for (uint8_t index = 0; index < config.orangePiUrlCount; index++) {
    JsonDocument response;
    int statusCode = 0;
    const String url = config.orangePiUrls[index] + "/api/slaves/" + config.slaveId + "/telemetry";
    if (postJson(url, config.apiToken, request, response, statusCode) && statusCode == 200) {
      Serial.printf("Telemetry sent: soil=%d%% pump=%s\n", soilPercent, pumpOn ? "ON" : "OFF");
      return true;
    }
  }
  Serial.println("Telemetry delivery failed");
  return false;
}

void monitorResetButton() {
  if (digitalRead(RESET_BUTTON_PIN) == LOW) {
    if (!resetPressedAt) resetPressedAt = millis();
    if (millis() - resetPressedAt >= RESET_HOLD_MS) {
      setPump(false);
      clearConfig();
      Serial.println("Configuration cleared; restarting setup portal");
      delay(100);
      ESP.restart();
    }
  } else resetPressedAt = 0;
}

void setup() {
  Serial.begin(115200);
  pinMode(RELAY_PIN, OUTPUT);
  pinMode(RESET_BUTTON_PIN, INPUT_PULLUP);
  setPump(false);
  if (!LittleFS.begin()) {
    LittleFS.format();
    if (!LittleFS.begin()) {
      Serial.println("LittleFS unavailable");
      return startSetupPortal();
    }
  }
#if ENABLE_DHT_SENSOR
  dht.begin();
#endif
  if (!loadConfig() || !connectToFarmWifi()) return startSetupPortal();
  claimOrangePiToken();
}

void loop() {
  monitorResetButton();
  if (setupMode) {
    setupServer.handleClient();
    if (restartRequested && static_cast<long>(millis() - restartAt) >= 0) ESP.restart();
    delay(2);
    return;
  }
  if (WiFi.status() != WL_CONNECTED) {
    setPump(false);
    if (!connectToFarmWifi()) {
      delay(5000);
      return;
    }
  }
  if (!config.apiToken.length() && millis() - lastClaimAttemptAt >= 10000) {
    lastClaimAttemptAt = millis();
    claimOrangePiToken();
  }
  if (config.apiToken.length() && (lastTelemetryAt == 0 || millis() - lastTelemetryAt >= TELEMETRY_INTERVAL_MS)) {
    lastTelemetryAt = millis();
    sendTelemetry();
  }
  delay(10);
}

