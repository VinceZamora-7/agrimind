function parseJson(response) {
  const text = response.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim();
  if (!text) throw new Error("Gemini returned no plant analysis");
  return JSON.parse(text);
}

function createGeminiPlantAnalyzer(config, quotaGate) {
  return {
    async analyze({ imageBase64, mimeType, slaveId, telemetry, requestId }) {
      if (!config.gemini.enabled || !config.gemini.apiKey) throw Object.assign(new Error("Gemini is not enabled"), { status: 503 });
      const gate = quotaGate.check();
      if (!gate.allowed) throw Object.assign(new Error(gate.reason), {
        status: 429,
        code: gate.reason,
        retry_after_seconds: gate.retry_after_seconds,
        retry_at: gate.retry_at,
      });
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.gemini.model)}:generateContent`;
      const sensorContext = telemetry
        ? JSON.stringify(telemetry)
        : "No current sensor reading is available. Do not invent sensor values.";
      const prompt = [
        "You are assisting a farmer with a photographed plant.",
        "Identify the likely common and scientific name, visually assess plant health and possible disease or deficiency, and consider the sensor readings.",
        "Do not claim certainty from an image alone. If uncertain, say so and recommend confirmation by an agricultural professional.",
        "All advice and explanations must be in clear Tagalog. Keep scientific name in its standard Latin form.",
        `Selected sensor: ${slaveId}. Latest readings: ${sensorContext}`,
      ].join("\n");
      const body = {
        contents: [{ role: "user", parts: [
          { inline_data: { mime_type: mimeType, data: imageBase64 } },
          { text: prompt },
        ] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json",
          responseSchema: {
            type: "object",
            required: ["plant_name", "scientific_name", "health_status", "possible_disease", "confidence", "observations_tagalog", "recommendations_tagalog"],
            properties: {
              plant_name: { type: "string" },
              scientific_name: { type: "string" },
              health_status: { type: "string", enum: ["normal", "abnormal", "uncertain"] },
              possible_disease: { type: "string" },
              confidence: { type: "number", minimum: 0, maximum: 100 },
              observations_tagalog: { type: "array", items: { type: "string" } },
              recommendations_tagalog: { type: "array", items: { type: "string" } },
              sensor_assessment_tagalog: { type: "string" },
              warning_signs_tagalog: { type: "array", items: { type: "string" } },
            },
          },
        },
      };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.gemini.timeoutMs);
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": config.gemini.apiKey },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const payload = await response.json();
        if (!response.ok) throw Object.assign(new Error(payload.error?.message || `Gemini HTTP ${response.status}`), { status: response.status });
        const result = parseJson(payload);
        quotaGate.record({ event_id: requestId, kind: "plant_analysis", model: config.gemini.model, status: "success", estimated_cost_usd: config.gemini.estimatedRequestUsd, usage: payload.usageMetadata || null });
        return { ...result, slave_id: slaveId, telemetry: telemetry || null, analyzed_at: new Date().toISOString(), model: config.gemini.model };
      } catch (error) {
        if (error.name === "AbortError") {
          error.status = 504;
          error.code = "gemini_timeout";
        }
        quotaGate.record({ event_id: requestId, kind: "plant_analysis", model: config.gemini.model, status: "failed", error: error.message });
        throw error;
      } finally { clearTimeout(timer); }
    },
  };
}

module.exports = { createGeminiPlantAnalyzer, parseJson };
