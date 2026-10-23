import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExpandedRow } from '../ExpandedRow';

import { useSearchQueryParamsStore } from '@/stores/useSearchQueryParams';

const data = {
  message: 'hello "world"\nnext',
  context: { user: { name: 'Ada' }, attempts: [1, false, null] },
  emptyObject: {},
  emptyArray: [],
};

const toggle = (path: string) => screen.getByRole('button', { name: `Toggle ${path}` });
const openTree = () => fireEvent.click(screen.getByRole('button', { name: 'JSON tree' }));

beforeEach(() => {
  useSearchQueryParamsStore.setState({ searchQuery: '' });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(cleanup);

describe('expanded log JSON tree', () => {
  it('uses original structured JSON when search fields are flattened or projected', () => {
    render(
      <ExpandedRow
        data={{ _raw: '{"context":{"enabled":true,"optional":null}}', 'context.enabled': true }}
      />
    );
    openTree();
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(screen.getByText('"enabled":')).toBeInTheDocument();
    expect(screen.getByText('null')).toBeInTheDocument();
    expect(screen.queryByText('"context.enabled":')).not.toBeInTheDocument();
    expect(screen.queryByText('"_raw":')).not.toBeInTheDocument();
  });

  it('supports an original JSON array', () => {
    render(<ExpandedRow data={{ _raw: '[{"name":"Ada"}]', timestamp: '2026-10-23T00:00:00Z' }} />);
    openTree();
    expect(toggle('$["0"]')).toHaveTextContent('{…} 1 property');
    fireEvent.click(toggle('$["0"]'));
    expect(screen.getByText('"Ada"')).toBeInTheDocument();
  });

  it('copies the original JSON from the tree header and root', async () => {
    render(
      <ExpandedRow data={{ _raw: '{"context":{"enabled":true}}', 'context.enabled': true }} />
    );
    openTree();
    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }));
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(
      '{\n  "context": {\n    "enabled": true\n  }\n}'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy JSON at $' }));
    await waitFor(() => expect(screen.getByText('Copied')).toBeInTheDocument());
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(
      '{\n  "context": {\n    "enabled": true\n  }\n}'
    );
  });

  it.each(['plain text', '{broken json', 'null', '123', '"text"'])(
    'falls back to fields for raw log %s',
    (raw) => {
      render(<ExpandedRow data={{ _raw: raw, message: 'fallback' }} />);
      openTree();
      expect(screen.getByText('"fallback"')).toBeInTheDocument();
    }
  );

  it('opens nested objects and arrays individually with compact counts', () => {
    render(<ExpandedRow data={data} />);
    openTree();
    expect(toggle('$["context"]')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('{…} 2 properties')).toBeInTheDocument();
    expect(screen.queryByText('"Ada"')).not.toBeInTheDocument();
    fireEvent.click(toggle('$["context"]'));
    expect(toggle('$["context"]["attempts"]')).toHaveTextContent('[…] 3 items');
    fireEvent.click(toggle('$["context"]["user"]'));
    expect(screen.getByText('"Ada"')).toBeInTheDocument();
    fireEvent.click(toggle('$["context"]'));
    expect(screen.queryByText('"Ada"')).not.toBeInTheDocument();
    expect(screen.getByText('{}')).toBeInTheDocument();
    expect(screen.getByText('[]')).toBeInTheDocument();
  });

  it('expands and collapses all descendants, including previously toggled nodes', () => {
    render(<ExpandedRow data={data} />);
    openTree();
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(screen.getByText('"Ada"')).toBeInTheDocument();
    expect(screen.getByText('false')).toBeInTheDocument();
    expect(screen.getByText('null')).toBeInTheDocument();
    fireEvent.click(toggle('$["context"]'));
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(screen.getByText('"Ada"')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(toggle('$')).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle('$'));
    expect(toggle('$["context"]')).toHaveAttribute('aria-expanded', 'false');
  });

  it('copies strings, scalars, and subtrees as valid JSON', async () => {
    render(<ExpandedRow data={data} />);
    openTree();
    fireEvent.click(screen.getByRole('button', { name: 'Copy JSON at $["message"]' }));
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith('"hello \\"world\\"\\nnext"');
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy JSON at $["context"]["user"]' }));
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith('{\n  "name": "Ada"\n}');
    fireEvent.click(
      screen.getByRole('button', { name: 'Copy JSON at $["context"]["attempts"]["1"]' })
    );
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith('false');
    await waitFor(() =>
      expect(screen.getAllByRole('status').some((node) => node.textContent === 'Copied')).toBe(true)
    );
  });

  it('reports clipboard failure without claiming a successful copy', async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValue(new Error('denied'));
    render(<ExpandedRow data={data} />);
    openTree();
    fireEvent.click(screen.getByRole('button', { name: 'Copy JSON at $["message"]' }));
    expect(await screen.findByText('Copy failed')).toBeInTheDocument();
    expect(screen.queryByText('Copied')).not.toBeInTheDocument();
  });

  it('renders array elements without object keys and separates sibling values', () => {
    render(<ExpandedRow data={data} />);
    openTree();
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(screen.queryByText('"0":')).not.toBeInTheDocument();
    expect(screen.getByText('1').parentElement).toHaveTextContent(/^1,$/);
    expect(screen.getByText('false').parentElement).toHaveTextContent(/^false,$/);
    expect(screen.getByText('null').parentElement).toHaveTextContent(/^null$/);
  });

  it('keeps paths distinct when keys contain dots, brackets, quotes, or slashes', () => {
    render(<ExpandedRow data={{ 'a.b': { x: 1 }, a: { b: { x: 2 } }, '"[/': [3] }} />);
    openTree();
    fireEvent.click(toggle('$["a.b"]'));
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(toggle('$["a"]')).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle('$["\\"[/"]'));
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('retains the fields, raw JSON, and search highlighting views', () => {
    useSearchQueryParamsStore.setState({ searchQuery: 'Ada' });
    const { container } = render(<ExpandedRow data={data} />);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('Ada', { selector: 'span.bg-yellow-300' })).toBeInTheDocument();
    openTree();
    fireEvent.click(screen.getByRole('button', { name: 'Raw log' }));
    expect(container.querySelector('pre')).toHaveTextContent('"context":');
    expect(screen.getByText('Ada', { selector: 'span.bg-yellow-300' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Extracted fields' }));
    expect(screen.getByRole('table')).toBeInTheDocument();
  });
});
