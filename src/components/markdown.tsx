import ReactMarkdown, { type Components } from "react-markdown";

// Model output is rendered as Markdown; raw HTML is not allowed by react-markdown.
const components: Components = {
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }) => (
    <ul className="mb-2 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-2 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold">{children}</strong>
  ),
  // Code blocks scroll inside the bubble instead of widening the page.
  pre: ({ children }) => (
    <pre className="mb-2 max-w-full overflow-x-auto rounded bg-black/10 p-2 font-mono text-xs last:mb-0 dark:bg-white/10 [&>code]:bg-transparent [&>code]:p-0">
      {children}
    </pre>
  ),
  code: ({ children }) => (
    <code className="rounded bg-black/10 px-1 font-mono text-[0.9em] dark:bg-white/10">
      {children}
    </code>
  ),
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer" className="underline">
      {children}
    </a>
  ),
};

export function Markdown({ text }: { text: string }) {
  return <ReactMarkdown components={components}>{text}</ReactMarkdown>;
}
