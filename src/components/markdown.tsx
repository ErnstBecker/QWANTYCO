import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// Model output is rendered as Markdown; raw HTML is not allowed by react-markdown.
const components: Components = {
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  // One level below the page h1; sizes stay small for a chat bubble.
  h1: ({ children }) => (
    <h2 className="mb-2 text-base font-semibold last:mb-0">{children}</h2>
  ),
  h2: ({ children }) => (
    <h3 className="mt-3 mb-1 font-semibold first:mt-0">{children}</h3>
  ),
  h3: ({ children }) => (
    <h4 className="mt-3 mb-1 font-semibold first:mt-0">{children}</h4>
  ),
  hr: () => <hr className="my-3 border-black/10 dark:border-white/10" />,
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
  // Tables scroll inside the bubble instead of widening the page.
  table: ({ children }) => (
    <div className="mb-2 max-w-full overflow-x-auto last:mb-0">
      <table className="border-collapse text-left text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-black/20 px-2 py-1 font-semibold dark:border-white/20">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-black/10 px-2 py-1 dark:border-white/10">
      {children}
    </td>
  ),
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer" className="underline">
      {children}
    </a>
  ),
};

export function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {text}
    </ReactMarkdown>
  );
}
