import { describe, it, expect } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';

describe('JSDOM Project Smoke Test', () => {
  it('renders a React component in jsdom', () => {
    render(<div data-testid="smoke-element">Tender Tracker JSDOM Ready</div>);
    const el = screen.getByTestId('smoke-element');
    expect(el).toBeInTheDocument();
    expect(el).toHaveTextContent('Tender Tracker JSDOM Ready');
  });
});
