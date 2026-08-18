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
        "Identify the likely common plant name and plant_scientific_name, then visually assess plant health and possible disease or deficiency using the image and sensor readings.",
        "Estimate disease_probability as the probability that the named disease, deficiency, or pest is present—not confidence in the plant identity. Use 0 when no disease is supported, 1-39 for weak evidence, 40-69 for plausible evidence, 70-89 for strong evidence, and 90-99 only for unmistakable visible symptoms. Never return 100. Sensor abnormalities may support risk but cannot prove a disease without visible symptoms.",
        "Do not claim certainty from an image alone. If uncertain, say so and recommend confirmation by an agricultural professional.",
        "All advice and explanations must be in clear Tagalog. plant_scientific_name must be the scientific name of the plant and must remain separate from disease_scientific_name.  possible_disease must contain the disease, deficiency, or pest name—not the plant name. disease_scientific_name must contain its accepted scientific disease name or causal pathogen/pest name. When a specific possible_disease is provided and a scientific causal name is known, do not return Not applicable. Use Not applicable only when no specific disease, pathogen, deficiency, or pest is supported.",
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
            required: ["plant_name", "plant_scientific_name", "disease_scientific_name", "health_status", "possible_disease", "disease_probability", "observations_tagalog", "recommendations_tagalog"],
            properties: {
              plant_name: { type: "string" },
              plant_scientific_name: { type: "string" },
              disease_scientific_name: { type: "string" },
              health_status: { type: "string", enum: ["normal", "abnormal", "uncertain"] },
              possible_disease: { type: "string" },
              disease_probability: { type: "number", minimum: 0, maximum: 99 },
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
        const parsed = parseJson(payload);
        const noDisease = parsed.health_status === "normal" || /^(none|not applicable|walang)/i.test(String(parsed.possible_disease || "").trim());
        const result = { ...parsed, disease_probability: noDisease ? 0 : Math.max(0, Math.min(99, Number(parsed.disease_probability) || 0)) };
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
