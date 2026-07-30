# Agrimind ESP8266 Slave Firmware

Initial firmware for a NodeMCU 1.0 / ESP-12E plant zone.

It provides:

- mobile Wi-Fi setup without hardcoded router credentials;
- a password-protected Agrimind-Slave-Setup hotspot;
- one-time secure pairing with the Orange Pi;
- a unique permanent API token for each slave;
- soil-moisture telemetry every 30 seconds;
- optional DHT11/DHT22 temperature and humidity;
- a relay output kept OFF by default;
- a five-second physical configuration-reset button.

## Known-parts wiring

| Device | NodeMCU pin | Notes |
| --- | --- | --- |
| Soil sensor analog output | A0 | Verify its output voltage first. |
| Soil sensor VCC | 3V3 | Use a 3.3 V-compatible sensor/module. |
| Soil sensor GND | GND | Common ground. |
| Relay input | D1 / GPIO5 | Default assumes an active-LOW module. |
| Setup reset button | D5 / GPIO14 | Momentary button from D5 to GND. |
| Optional DHT data | D2 / GPIO4 | Disabled in the initial build. |

Never power the pump from the ESP8266 or its 3.3 V pin. Use a correctly rated
external pump supply and a suitable relay or MOSFET module. Keep pump power
wiring isolated from the low-voltage sensor wiring.

## Safe pump default

ENABLE_AUTOMATIC_PUMP is false in src/main.cpp. Uploading this firmware will
therefore keep the pump off. Confirm the relay active level, pump supply,
tubing, and moisture calibration before enabling automatic pumping.

## Build and upload

Install VS Code and PlatformIO, connect the NodeMCU by USB, and run these
commands from firmware/esp8266-slave:

    pio run
    pio run --target upload
    pio device monitor

The configured PlatformIO board ID is nodemcuv2.

## Mobile provisioning

1. Open Settings, Plant Zones, then Set Up ESP8266.
2. Enter the farm Wi-Fi name and password.
3. Tap Prepare Secure Setup.
4. Connect the phone to:
   - Wi-Fi: Agrimind-Slave-Setup
   - Password: agrimind-setup
5. Return to Agrimind and tap Send Setup to ESP8266.
6. Reconnect the phone to the farm Wi-Fi.

The ESP joins the router, claims its unique token, and sends readings to the
Orange Pi. The Dashboard then receives slave_telemetry through WebSocket.

## Soil-sensor calibration

The current values are placeholders:

- SOIL_RAW_DRY = 800
- SOIL_RAW_WET = 350

Measure and replace them:

1. Record analogRead(A0) in dry soil or air.
2. Record analogRead(A0) in fully wet soil.
3. Replace both constants, rebuild, and upload.

Do not use the placeholder percentages for automatic watering.

## Optional DHT11 or DHT22

Temperature and humidity are currently disabled. After identifying the part:

1. Keep DHT_TYPE as DHT22 or change it to DHT11.
2. Change ENABLE_DHT_SENSOR from 0 to 1 in platformio.ini.
3. Connect its data output to D2 / GPIO4.
4. Rebuild and upload.

