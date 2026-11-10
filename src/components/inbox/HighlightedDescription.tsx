import React, { useMemo } from 'react';

interface HighlightedDescriptionProps {
  text: string;
  keywords: string[];
}

/**
 * Renders description text with matched domain keywords highlighted
 */
export function HighlightedDescription({ text, keywords }: HighlightedDescriptionProps) {
  const cleanKeywords = useMemo(() => {
    return keywords
      .map(k => k.replace(/^[✨🔍#\s]+/, '').trim())
      .filter(k => k.length > 2);
  }, [keywords]);

  const elements = useMemo(() => {
    if (!text || cleanKeywords.length === 0) {
      return text;
    }

    // Escape regex characters
    const escaped = cleanKeywords.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const pattern = new RegExp(`(\\b(?:${escaped.join('|')})\\b)`, 'gi');

    const parts = text.split(pattern);
    return parts.map((part, index) => {
      const isMatch = cleanKeywords.some(k => k.toLowerCase() === part.toLowerCase());
      if (isMatch) {
        return (
          <mark
            key={index}
            className="rounded bg-accent-soft px-1 py-0.5 font-semibold text-accent not-italic"
          >
            {part}
          </mark>
        );
      }
      return part;
    });
  }, [text, cleanKeywords]);

  return <p className="whitespace-pre-wrap leading-relaxed text-ink">{elements}</p>;
}
