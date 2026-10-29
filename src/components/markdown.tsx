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
