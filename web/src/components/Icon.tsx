const PATHS: Record<string, string> = {
  pipeline: 'M2 3h3.5v10H2zM6.25 3h3.5v6h-3.5zM10.5 3H14v8h-3.5z',
  enquiries: 'M3 3.5h10M3 8h10M3 12.5h6',
  procurement: 'M2.5 5.5L8 3l5.5 2.5v5L8 13l-5.5-2.5zM2.5 5.5L8 8m0 0l5.5-2.5M8 8v5',
  estimation: 'M3 13V9M7 13V5M11 13V7M14 13H2',
  quotation: 'M4 2h5.5L13 5.5V14H4zM9 2v4h4M6 9h5M6 11.5h5',
  price: 'M2 12l3.5-4 3 2.5L14 4M10.5 4H14v3.5',
  approvals: 'M3 8.5l3 3L13 4.5',
  admin: 'M8 2l5 2v4c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4z',
  search: 'M7 12a5 5 0 100-10 5 5 0 000 10zM14 14l-3.5-3.5',
  menu: 'M2.5 4h11M2.5 8h11M2.5 12h11',
  close: 'M3.5 3.5l9 9M12.5 3.5l-9 9',
  plus: 'M8 3v10M3 8h10',
  chevron: 'M6 3.5L10.5 8 6 12.5',
  download: 'M8 2.5v8M4.5 7.5L8 11l3.5-3.5M3 13.5h10',
  alert: 'M8 2.5l6 10.5H2zM8 7v3M8 11.5v.5',
};

export function Icon({ name, size = 16 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? PATHS.enquiries} />
    </svg>
  );
}
