export const money = (amount: number) =>
  new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND" }).format(
    amount,
  );
export const time = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat("vi-VN", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: "Asia/Ho_Chi_Minh",
      }).format(new Date(value))
    : "—";
export const inputClass =
  "min-h-11 w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600";
export const panelClass =
  "min-w-0 rounded-xl border border-slate-200 bg-white p-4 sm:p-6";
export const financeError = (error: unknown) => {
  const message = (error as { response?: { data?: { message?: unknown } } })
    ?.response?.data?.message;
  return typeof message === "string"
    ? message
    : "Chưa thể tải hoặc lưu dữ liệu. Vui lòng thử lại.";
};
