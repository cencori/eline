import Link from "next/link";

export default function DocsHome() {
  return (
    <article className="max-w-none">
      <h1 className="text-2xl font-semibold tracking-tight mb-3">Zett Documentation</h1>
      <p className="text-sm text-muted mb-8">
        Build agents faster than the speed of light.
      </p>
      <hr className="border-border/30 mb-8" />

      <h2 className="text-base font-semibold tracking-tight mb-2">Getting Started</h2>
      <p className="text-xs text-muted leading-relaxed mb-4">
        Create a new project, define your first agent, and run it locally &mdash; all
        in under a minute.
      </p>
      <pre className="rounded-xl border border-border/30 bg-card p-4 text-xs overflow-x-auto font-mono mb-4">
        <code>{`npx zett@latest init my-agent
cd my-agent
npm run dev`}</code>
      </pre>
      <Link
        href="/docs/getting-started"
        className="inline-flex items-center gap-2 h-7 rounded-md border border-border/20 bg-transparent px-3 text-[11px] font-medium text-foreground/90 hover:border-foreground/40 hover:bg-foreground/5 transition-all"
      >
        Read Getting Started &rarr;
      </Link>

      <hr className="border-border/30 my-8" />

      <h2 className="text-base font-semibold tracking-tight mb-2">Project Layout</h2>
      <p className="text-xs text-muted leading-relaxed mb-4">
        Agents in Zett are defined as files in your project. Each directory is a
        slot with a specific purpose.
      </p>
      <Link
        href="/docs/project-layout"
        className="inline-flex items-center gap-2 h-7 rounded-md border border-border/20 bg-transparent px-3 text-[11px] font-medium text-foreground/90 hover:border-foreground/40 hover:bg-foreground/5 transition-all"
      >
        Learn about the layout &rarr;
      </Link>

      <hr className="border-border/30 my-8" />

      <h2 className="text-base font-semibold tracking-tight mb-2">Why Zett?</h2>
      <ul className="text-xs text-muted space-y-2 leading-relaxed">
        <li><strong className="text-foreground">Filesystem-first</strong> &mdash; no SDK boilerplate, no DSL, no hidden state</li>
        <li><strong className="text-foreground">Built on Cencori</strong> &mdash; model routing, billing, security handled out of the box</li>
        <li><strong className="text-foreground">Open source</strong> &mdash; MIT License, community-driven</li>
        <li><strong className="text-foreground">Instant deploy</strong> &mdash; compile to a manifest and ship</li>
      </ul>
    </article>
  );
}
