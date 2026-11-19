'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Agent replies are markdown. Raw HTML stays disabled (react-markdown's
// default), so nothing in a message can inject markup. Colours derive from
// currentColor so the same components work on dark boss bubbles and light
// agent bubbles; images render as links (a remote <img> would leak the reader's
// IP to whoever wrote the message).
export function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
        strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
        em: ({ children }) => <em className="italic">{children}</em>,
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:opacity-80"
          >
            {children}
          </a>
        ),
        ul: ({ children }) => <ul className="my-2 list-disc space-y-0.5 pl-5">{children}</ul>,
        ol: ({ children }) => <ol className="my-2 list-decimal space-y-0.5 pl-5">{children}</ol>,
        li: ({ children }) => <li className="leading-snug">{children}</li>,
        code: ({ className, children }) => {
          const block =
            (typeof className === 'string' && className.includes('language-')) ||
            String(children).includes('\n');
          if (block) return <code className={className}>{children}</code>;
          return (
            <code className="rounded border border-current/25 bg-black/10 px-1 py-px font-mono text-[12px] dark:bg-black/30">
              {children}
            </code>
          );
        },
        pre: ({ children }) => (
          <pre className="my-2 overflow-x-auto rounded-md border border-current/20 bg-black/10 p-2 font-mono text-[12px] dark:bg-black/30">
            {children}
          </pre>
        ),
        table: ({ children }) => (
          <div className="my-2 overflow-x-auto">
            <table className="border-collapse text-[12px]">{children}</table>
          </div>
        ),
        th: ({ children }) => (
          <th className="border border-current/25 px-2 py-1 text-left font-semibold">{children}</th>
        ),
        td: ({ children }) => <td className="border border-current/25 px-2 py-1">{children}</td>,
        blockquote: ({ children }) => (
          <blockquote className="my-2 border-l-2 border-current/30 pl-3 opacity-85">
            {children}
          </blockquote>
        ),
        hr: () => <hr className="my-3 border-current/20" />,
        h1: ({ children }) => <h1 className="mt-2 mb-1 text-base font-semibold">{children}</h1>,
        h2: ({ children }) => <h2 className="mt-2 mb-1 text-sm font-semibold">{children}</h2>,
        h3: ({ children }) => <h3 className="mt-2 mb-1 text-sm font-semibold">{children}</h3>,
        img: ({ src, alt }) => (
          <a
            href={typeof src === 'string' ? src : undefined}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:opacity-80"
          >
            [image{alt ? `: ${alt}` : ''}]
          </a>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
