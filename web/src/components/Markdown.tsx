'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Agent replies are markdown. Raw HTML stays disabled (react-markdown's
// default), so nothing in a message can inject markup.
export function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
        strong: ({ children }) => <strong className="font-semibold text-white">{children}</strong>,
        em: ({ children }) => <em className="italic">{children}</em>,
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-white"
          >
            {children}
          </a>
        ),
        ul: ({ children }) => <ul className="my-2 list-disc space-y-0.5 pl-5">{children}</ul>,
        ol: ({ children }) => <ol className="my-2 list-decimal space-y-0.5 pl-5">{children}</ol>,
        li: ({ children }) => <li className="leading-snug">{children}</li>,
        code: ({ className, children }) => {
          const block = typeof className === 'string' && className.includes('language-');
          if (block) return <code className={className}>{children}</code>;
          return (
            <code className="rounded border border-white/15 bg-black/30 px-1 py-px font-mono text-[12px]">
              {children}
            </code>
          );
        },
        pre: ({ children }) => (
          <pre className="my-2 overflow-x-auto rounded-md border border-white/15 bg-black/30 p-2 font-mono text-[12px]">
            {children}
          </pre>
        ),
        table: ({ children }) => (
          <div className="my-2 overflow-x-auto">
            <table className="border-collapse text-[12px]">{children}</table>
          </div>
        ),
        th: ({ children }) => (
          <th className="border border-white/20 px-2 py-1 text-left font-semibold">{children}</th>
        ),
        td: ({ children }) => <td className="border border-white/20 px-2 py-1">{children}</td>,
        blockquote: ({ children }) => (
          <blockquote className="my-2 border-l-2 border-white/25 pl-3 text-white/80">
            {children}
          </blockquote>
        ),
        hr: () => <hr className="my-3 border-white/15" />,
        h1: ({ children }) => <h1 className="mt-2 mb-1 text-base font-semibold">{children}</h1>,
        h2: ({ children }) => <h2 className="mt-2 mb-1 text-sm font-semibold">{children}</h2>,
        h3: ({ children }) => <h3 className="mt-2 mb-1 text-sm font-semibold">{children}</h3>,
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
