export function Logo({
  className = 'h-7',
  inverted = false,
}: {
  className?: string;
  inverted?: boolean;
}) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <svg viewBox="0 0 32 32" aria-hidden="true" className="h-full w-auto">
        <rect width="32" height="32" rx="8" className="fill-brand-600" />
        <path d="M9 10h14M9 16h9M9 22h12" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
      <span
        className={`text-lg font-semibold tracking-tight ${inverted ? 'text-white' : 'text-slate-900'}`}
      >
        deskline
      </span>
    </span>
  );
}
