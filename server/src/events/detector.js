const { sleep } = require("../utils/process");

function createRearmGate({ debounceReadings, rearmLowMs, initialValue = 0, initialNow = Date.now() }) {
  let armed = initialValue === 0;
  let consecutiveHigh = 0;
  let lowSince = armed ? initialNow : null;

  function snapshot() {
    return { armed, consecutiveHigh, lowSince, canTrigger: armed && consecutiveHigh >= debounceReadings };
  }

  return {
    update(current, now = Date.now()) {
      let rearmed = false;
      if (current === 0) {
        consecutiveHigh = 0;
        if (!armed) {
          if (lowSince === null) lowSince = now;
          if (now - lowSince >= rearmLowMs) {
            armed = true;
            rearmed = true;
          }
        }
      } else {
        consecutiveHigh += 1;
        lowSince = null;
      }
      return { ...snapshot(), rearmed };
    },
    consume() {
      armed = false;
      lowSince = null;
      return snapshot();
    },
    snapshot,
  };
}

function createDetector({ config, pir, eventService, realtime, state }) {
  let running = false;
  async function start() {
    if (running) return;
    running = true;
    let previous = await pir.read();
    state.pirState = previous;
    const gate = createRearmGate({ debounceReadings: config.pir.debounceReadings, rearmLowMs: config.pir.rearmLowMs, initialValue: previous });
    state.pirArmed = gate.snapshot().armed;
    console.log(`PIR detector watching ${config.pir.chip} line ${config.pir.line}; initial=${previous}`);
    while (running) {
      try {
        const current = await pir.read();
        state.pirState = current;
        const gateState = gate.update(current);
        state.pirArmed = gateState.armed;
        state.pirLowSince = gateState.lowSince ? new Date(gateState.lowSince).toISOString() : null;
        if (gateState.rearmed) {
          state.pirLastRearmedAt = new Date().toISOString();
          console.log(`PIR re-armed after ${config.pir.rearmLowMs / 1000}s continuously LOW`);
          realtime.broadcast("pir_rearmed", { gpio_chip: config.pir.chip, gpio_line: config.pir.line, low_seconds: config.pir.rearmLowMs / 1000 });
        }
        const sinceEvent = Date.now() - state.lastEventAt;
        if (state.detectionEnabled && gateState.canTrigger && sinceEvent >= Math.max(config.pir.cooldownMs, config.pir.groupingMs)) {
          state.lastEventAt = Date.now();
          const consumed = gate.consume();
          state.pirArmed = consumed.armed;
          state.pirLowSince = null;
          console.log(`Motion detected on ${config.pir.chip} line ${config.pir.line}`);
          realtime.broadcast("motion_detected", { gpio_chip: config.pir.chip, gpio_line: config.pir.line });
          await eventService.capture("pir_motion_sensor");
        } else if (current === 1 && sinceEvent < Math.max(config.pir.cooldownMs, config.pir.groupingMs)) state.suppressedTriggers += 1;
        previous = current;
      } catch (error) { state.lastHardwareError = error.message; realtime.broadcast("hardware_error", { error: error.message }); console.error("PIR loop:", error.message); }
      await sleep(config.pir.pollMs);
    }
  }
  return { start, stop: () => { running = false; }, isRunning: () => running };
}
module.exports = { createDetector, createRearmGate };
