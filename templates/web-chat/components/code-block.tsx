"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { Highlight, Prism } from "prism-react-renderer";
import { cn } from "@/lib/utils";

interface CodeBlockProps {
  code: string;
  language?: string;
  onCopy?(code: string): void;
}

const LANGUAGE_LABELS: Record<string, string> = {
  bash: "Shell",
  c: "C",
  cjs: "JavaScript",
  console: "Shell",
  cpp: "C++",
  cs: "C#",
  csharp: "C#",
  css: "CSS",
  go: "Go",
  graphql: "GraphQL",
  html: "HTML",
  java: "Java",
  javascript: "JavaScript",
  js: "JavaScript",
  json: "JSON",
  kotlin: "Kotlin",
  jsx: "JSX",
  markdown: "Markdown",
  md: "Markdown",
  mjs: "JavaScript",
  plaintext: "Plain text",
  py: "Python",
  python: "Python",
  rust: "Rust",
  sh: "Shell",
  shell: "Shell",
  sql: "SQL",
  swift: "Swift",
  terminal: "Shell",
  text: "Plain text",
  ts: "TypeScript",
  tsx: "TSX",
  typescript: "TypeScript",
  xml: "XML",
  yaml: "YAML",
  yml: "YAML",
  zsh: "Shell",
};

const HIGHLIGHT_LANGUAGE_ALIASES: Record<string, string> = {
  cs: "clike",
  csharp: "clike",
  console: "bash",
  java: "clike",
  plaintext: "plain",
  shell: "bash",
  sh: "bash",
  text: "plain",
  terminal: "bash",
  txt: "plain",
  zsh: "bash",
};

if (!Prism.languages.bash) {
  const shellGrammar = {
    comment: { pattern: /(^|[^\\])#.*/, lookbehind: true, greedy: true },
    string: [
      { pattern: /"(?:\\[\s\S]|[^"\\])*"/, greedy: true },
      { pattern: /'(?:[^']*)'/, greedy: true },
    ],
    variable: /\$(?:[\w#?*!@-]+|\{[^}]+\})/,
    keyword:
      /\b(?:case|do|done|elif|else|esac|fi|for|function|if|in|select|then|time|until|while)\b/,
    builtin:
      /\b(?:alias|cd|echo|eval|exec|exit|export|local|printf|pwd|read|readonly|return|set|shift|source|test|trap|type|ulimit|umask|unalias|unset|wait)\b/,
    function: /\b(?:arcie|bun|cargo|deno|docker|git|go|node|npm|npx|pip|pip3|pnpm|python|python3|ruby|yarn)(?=\s|$)/,
    boolean: /\b(?:false|true)\b/,
    number: /\b\d+(?:\.\d+)?\b/,
    operator: /&&?|\|\|?|;;?|<<?|>>?|[!=]=?/,
    punctuation: /[{}[\](),]/,
  };

  Prism.languages.bash = shellGrammar;
  Prism.languages.shell = shellGrammar;
  Prism.languages.sh = shellGrammar;
  Prism.languages.zsh = shellGrammar;
}

function getLanguageLabel(language?: string): string {
  if (!language) return "Code";
  const normalized = language.toLowerCase();
  return LANGUAGE_LABELS[normalized] ?? language;
}

function getHighlightLanguage(language?: string): string {
  if (!language) return "plain";
  const normalized = language.toLowerCase();
  const aliased = HIGHLIGHT_LANGUAGE_ALIASES[normalized] ?? normalized;
  return Prism.languages[aliased] ? aliased : "plain";
}

export function CodeBlock({ code, language, onCopy }: CodeBlockProps) {
  const [copied, setCopied] = React.useState(false);
  const cleanCode = code.replace(/\n$/, "");

  const handleCopy = () => {
    if (onCopy) {
      onCopy(cleanCode);
    } else {
      void navigator.clipboard.writeText(cleanCode);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <figure className="response-code-block my-3 overflow-hidden rounded-3xl border border-white/[0.12] bg-black shadow-[inset_0_1px_0_rgba(255,255,255,0.03),0_12px_30px_-26px_rgba(0,0,0,0.85)]">
      <figcaption className="flex items-center justify-between px-3.5 pt-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            aria-hidden="true"
            className="font-mono text-[12px] font-semibold tracking-[-0.1em] text-zinc-100"
          >
            {"</>"}
          </span>
          <span className="truncate text-[13px] font-medium tracking-[-0.01em] text-zinc-100">
            {getLanguageLabel(language)}
          </span>
        </div>

        <button
          type="button"
          onClick={handleCopy}
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-md transition duration-200",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30 focus-visible:ring-offset-2 focus-visible:ring-offset-black",
            copied
              ? "text-emerald-300"
              : "text-zinc-200 hover:bg-white/[0.06] hover:text-white active:translate-y-px",
          )}
          aria-label={copied ? "Code copied" : "Copy code"}
          title={copied ? "Copied" : "Copy code"}
        >
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        </button>
      </figcaption>

      <Highlight code={cleanCode} language={getHighlightLanguage(language)}>
        {({ tokens, getLineProps, getTokenProps }) => (
          <pre className="overflow-x-auto bg-transparent pb-3.5 pt-2 text-[13px] leading-[1.6] text-zinc-100">
            <code className="block w-max min-w-full font-mono">
              {tokens.map((line, lineIndex) => {
                const lineProps = getLineProps({ line });

                return (
                  <span
                    key={lineIndex}
                    {...lineProps}
                    className={cn(
                      "response-code-line block min-w-full px-3.5",
                      lineProps.className,
                    )}
                  >
                    <span className="whitespace-pre">
                      {line.map((token, tokenIndex) => {
                        const tokenProps = getTokenProps({ token });
                        return (
                          <span key={tokenIndex} className={tokenProps.className}>
                            {tokenProps.children}
                          </span>
                        );
                      })}
                    </span>
                  </span>
                );
              })}
            </code>
          </pre>
        )}
      </Highlight>
    </figure>
  );
}
