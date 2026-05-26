// src/handlers/stop.mjs
// Task 4 stub. Wired in Task 8 (per-turn message event + debounced checkpoint).

export async function handleStop(payload, deps) {
  await deps.log({ event: "Stop", has_last_assistant: !!payload?.last_assistant_message });
  return {};
}
