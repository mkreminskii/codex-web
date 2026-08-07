export function reportProgress(progress, message) {
  progress?.({ status: "info", message });
}

export async function runPhase(progress, phase, operation) {
  const startedAt = performance.now();
  progress?.({ status: "started", phase });

  try {
    const result = await operation();
    progress?.({
      status: "completed",
      phase,
      elapsedMs: performance.now() - startedAt,
    });
    return result;
  } catch (error) {
    progress?.({
      status: "failed",
      phase,
      elapsedMs: performance.now() - startedAt,
    });
    throw error;
  }
}

