/** Shared class names. Plain strings keep Tailwind's class detection working. */
const btnBase =
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50';

export const ui = {
  btnPrimary: `${btnBase} bg-brand-600 text-white shadow-sm hover:bg-brand-700`,
  btnNote: `${btnBase} bg-amber-600 text-white shadow-sm hover:bg-amber-700`,
  btnSecondary: `${btnBase} border border-slate-300 bg-white text-slate-700 shadow-sm hover:bg-slate-50`,
  btnGhost: `${btnBase} text-slate-600 hover:bg-slate-100 hover:text-slate-900`,
  btnDanger: `${btnBase} border border-red-200 bg-white text-red-700 hover:bg-red-50`,
  input:
    'block w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/30 focus:outline-none',
  label: 'mb-1 block text-xs font-medium text-slate-600',
  card: 'rounded-lg border border-slate-200 bg-white shadow-sm',
} as const;

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}
