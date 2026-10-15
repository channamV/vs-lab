/** Operator check-in pages: phone-first, no fleet-manager navigation. */
export default function CheckinLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="bg-slate-900 px-4 py-3 text-white">
        <div className="mx-auto max-w-md text-lg font-semibold tracking-tight">
          VS <span className="text-sky-400">Lab</span> <span className="text-sm font-normal text-slate-300">· Operator check-in</span>
        </div>
      </header>
      <main className="mx-auto w-full max-w-md flex-1 px-4 py-5">{children}</main>
    </>
  );
}
