export const invokeWithProcessingReceipts = async ({ invoke, record }) => {
  record?.("started");
  try {
    const result = await invoke();
    record?.("completed");
    return result;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    record?.("failed", { errorMessage: error.message });
    throw error;
  }
};
