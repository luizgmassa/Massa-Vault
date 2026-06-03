import { readState } from "./state.js";

export function createNotesDaemonController(service) {
  return {
    handleRequestedAction(action) {
      if (!action) return false;

      if (action === "resume") {
        service.paused = false;
        service.clearConflicts();
        service.updateState({
          paused: false,
          alert: null,
          requestedAction: null,
          resumedAt: new Date().toISOString(),
          lastError: null
        });
        return true;
      }

      if (action === "flush-push" || action === "flush-sync" || action === "sync") {
        service.updateState({ requestedAction: null });
        void service.runSync({ reason: action });
        return true;
      }

      return false;
    }
  };
}

export function pollRequestedAction(service) {
  const state = readState();
  const action = state.requestedAction;
  if (!action) return false;
  return createNotesDaemonController(service).handleRequestedAction(action);
}
