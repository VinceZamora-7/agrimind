const fs = require("fs");

function parseCandidate(response) {
  const text = response.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim();
  if (!text) throw new Error("Gemini returned no classification");
  const parsed = JSON.parse(text);
  if (!["human", "animal", "nothing"].includes(parsed.label)) throw new Error("Gemini returned an invalid label");
  const allowedVisibility = ["full", "mostly_visible", "partial", "unclear", "none"];
  const visibility = allowedVisibility.includes(parsed.visibility) ? parsed.visibility : "unclear";
  const confidenceCaps = { full: 99, mostly_visible: 95, partial: 85, unclear: 60, none: 99 };
  const confidence = Math.max(0, Math.min(confidenceCaps[visibility], Number(parsed.confidence) || 0));
  const label = visibility === "none" ? "nothing" : parsed.label;
  return { label, confidence, visibility, reason: String(parsed.reason || "") };
}

function createGeminiClassifier(config, quotaGate) {
  return {
    async classify(imagePath, eventId, eventTimestamp) {
      const gate = quotaGate.check();
      if (!gate.allowed) return { skipped: true, reason: gate.reason };
      const imageBase64 = fs.readFileSync(imagePath).toString("base64");
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.gemini.model)}:generateContent`;
      const body = {
        contents: [{ role: "user", parts: [
          { inline_data: { mime_type: "image/jpeg", data: imageBase64 } },
          { text: "Act as a cautious farm security image classifier. Return human only when directly visible human anatomy, clothing, or a human silhouette is supported by the pixels. Return animal only when directly visible non-human animal features such as a face, body, limbs, fur, feathers, or a tail are supported by the pixels. Never infer an animal or person from shadows, glare, foliage, objects, blur, darkness, or camera noise. If evidence is ambiguous, too dark, too small, or obstructed, return nothing. Set visibility to full, mostly_visible, partial, unclear, or none. Calibrate confidence: full may be 86-99, mostly_visible 71-95, partial 51-85, unclear at most 60, and never return 100. In reason, name only concrete visible evidence and explicitly mention obstruction or darkness. Do not identify a person." },
        ] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json",
          responseSchema: { type: "object", required: ["label", "confidence", "visibility", "reason"], properties: {
            label: { type: "string", enum: ["human", "animal", "nothing"] },
            confidence: { type: "number", minimum: 0, maximum: 99 },
            visibility: { type: "string", enum: ["full", "mostly_visible", "partial", "unclear", "none"] },
            reason: { type: "string" },
          } },
        },
      };
      let lastError;
      for (let attempt = 0; attempt <= config.gemini.maxRetries; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), config.gemini.timeoutMs);
        try {
          const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": config.gemini.apiKey }, body: JSON.stringify(body), signal: controller.signal });
          const payload = await response.json();
          if (!response.ok) throw Object.assign(new Error(payload.error?.message || `Gemini HTTP ${response.status}`), { status: response.status });
          const result = parseCandidate(payload);
          quotaGate.record({ timestamp: eventTimestamp, event_id: eventId, model: config.gemini.model, status: "success", estimated_cost_usd: config.gemini.estimatedRequestUsd, usage: payload.usageMetadata || null });
          return { ...result, model: config.gemini.model, analyzed_at: new Date().toISOString(), usage: payload.usageMetadata || null };
        } catch (error) {
          lastError = error;
          const retryable = error.name === "AbortError" || error.status === 429 || error.status >= 500;
          if (!retryable || attempt >= config.gemini.maxRetries) break;
          await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
        } finally { clearTimeout(timer); }
      }
      quotaGate.record({ timestamp: eventTimestamp, event_id: eventId, model: config.gemini.model, status: "failed", error: lastError?.message || "unknown" });
      throw lastError;
    },
  };
}
module.exports = { createGeminiClassifier, parseCandidate };
