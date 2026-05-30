import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Tutorial from './Tutorial';

// Despite its name, Tutorial is a tabbed "Help & Information" modal with five
// tabs (About / Support / Tutorial / Terms / Privacy). Its ONLY data/IO
// mechanism is a global `fetch` to `${API_URL}/api/tutorial` fired on open; the
// response body's `tabs` object overrides per-tab markdown, otherwise built-in
// default content is rendered. Navigation/close happen purely via local state
// and the `onClose` callback prop. So we mock global.fetch and jest.fn() the
// onClose prop, and pin the CURRENT observable behavior with RTL.

const flushFetch = async () => {
  // Let the loadTutorialContent() promise chain resolve and loading clear.
  await waitFor(() =>
    expect(screen.queryByText('Loading content...')).not.toBeInTheDocument()
  );
};

const mockFetchTabs = (tabs: Record<string, string>) => {
  (global.fetch as jest.Mock).mockResolvedValue({
    ok: true,
    json: async () => ({ tabs }),
  });
};

describe('Tutorial', () => {
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tabs: {} }),
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders nothing when isOpen is false', () => {
    const onClose = jest.fn();
    const { container } = render(<Tutorial isOpen={false} onClose={onClose} />);
    expect(container.firstChild).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('renders the modal header and five tabs when open', async () => {
    const onClose = jest.fn();
    render(<Tutorial isOpen={true} onClose={onClose} />);

    expect(screen.getByText('Help & Information')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'About' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Support' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tutorial' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Terms' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Privacy' })).toBeInTheDocument();
    await flushFetch();
  });

  it('fetches tutorial content from the API on open', async () => {
    const onClose = jest.fn();
    render(<Tutorial isOpen={true} onClose={onClose} />);
    await flushFetch();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain('/api/tutorial');
  });

  it('shows the loading state before content resolves', () => {
    const onClose = jest.fn();
    // Never-resolving fetch keeps the component in its loading branch.
    (global.fetch as jest.Mock).mockReturnValue(new Promise(() => {}));
    render(<Tutorial isOpen={true} onClose={onClose} />);
    expect(screen.getByText('Loading content...')).toBeInTheDocument();
  });

  it('defaults to the Tutorial tab as active', async () => {
    const onClose = jest.fn();
    render(<Tutorial isOpen={true} onClose={onClose} />);
    expect(screen.getByRole('button', { name: 'Tutorial' })).toHaveClass('active');
    expect(screen.getByRole('button', { name: 'About' })).not.toHaveClass('active');
    await flushFetch();
  });

  it('honors the defaultTab prop for the initially active tab', async () => {
    const onClose = jest.fn();
    render(<Tutorial isOpen={true} onClose={onClose} defaultTab="privacy" />);
    expect(screen.getByRole('button', { name: 'Privacy' })).toHaveClass('active');
    expect(screen.getByRole('button', { name: 'Tutorial' })).not.toHaveClass('active');
    await flushFetch();
  });

  it('renders the default Tutorial content heading when API returns no tab overrides', async () => {
    const onClose = jest.fn();
    render(<Tutorial isOpen={true} onClose={onClose} />);
    await flushFetch();
    expect(screen.getByRole('heading', { name: 'Tutorial Guide' })).toBeInTheDocument();
  });

  it('switches to the About tab and renders its content when clicked', async () => {
    const onClose = jest.fn();
    render(<Tutorial isOpen={true} onClose={onClose} />);
    await flushFetch();

    fireEvent.click(screen.getByRole('button', { name: 'About' }));

    expect(screen.getByRole('button', { name: 'About' })).toHaveClass('active');
    expect(screen.getByRole('button', { name: 'Tutorial' })).not.toHaveClass('active');
    expect(screen.getByRole('heading', { name: 'About OneStreamer' })).toBeInTheDocument();
  });

  it('switches between Support, Terms and Privacy tabs rendering each content', async () => {
    const onClose = jest.fn();
    render(<Tutorial isOpen={true} onClose={onClose} />);
    await flushFetch();

    fireEvent.click(screen.getByRole('button', { name: 'Support' }));
    expect(screen.getByRole('heading', { name: 'Support & Help' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Terms' }));
    expect(screen.getByRole('heading', { name: 'Terms of Service' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Privacy' }));
    expect(screen.getByRole('heading', { name: 'Privacy Policy' })).toBeInTheDocument();
  });

  it('renders API-provided tab content (parsed markdown) over defaults', async () => {
    const onClose = jest.fn();
    mockFetchTabs({ tutorial: '# Custom Tutorial Heading\n\nHello world' });
    render(<Tutorial isOpen={true} onClose={onClose} />);
    await flushFetch();

    expect(
      screen.getByRole('heading', { name: 'Custom Tutorial Heading' })
    ).toBeInTheDocument();
    expect(screen.getByText('Hello world')).toBeInTheDocument();
  });

  it('parses inline markdown links into anchor elements', async () => {
    const onClose = jest.fn();
    mockFetchTabs({ tutorial: 'See [our site](https://example.com) now' });
    render(<Tutorial isOpen={true} onClose={onClose} />);
    await flushFetch();

    const link = screen.getByRole('link', { name: 'our site' });
    expect(link).toHaveAttribute('href', 'https://example.com');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('calls onClose when the close (×) button is clicked', async () => {
    const onClose = jest.fn();
    render(<Tutorial isOpen={true} onClose={onClose} />);
    await flushFetch();

    fireEvent.click(screen.getByRole('button', { name: '×' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when the overlay backdrop is clicked', async () => {
    const onClose = jest.fn();
    const { container } = render(<Tutorial isOpen={true} onClose={onClose} />);
    await flushFetch();

    fireEvent.click(container.querySelector('.tutorial-overlay') as Element);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onClose when the modal body is clicked (stopPropagation)', async () => {
    const onClose = jest.fn();
    const { container } = render(<Tutorial isOpen={true} onClose={onClose} />);
    await flushFetch();

    fireEvent.click(container.querySelector('.tutorial-modal') as Element);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('falls back to default content when the fetch rejects', async () => {
    const onClose = jest.fn();
    (global.fetch as jest.Mock).mockRejectedValue(new Error('network down'));
    render(<Tutorial isOpen={true} onClose={onClose} />);
    await flushFetch();

    expect(screen.getByRole('heading', { name: 'Tutorial Guide' })).toBeInTheDocument();
  });

  it('falls back to default content when the response is not ok', async () => {
    const onClose = jest.fn();
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, json: async () => ({}) });
    render(<Tutorial isOpen={true} onClose={onClose} defaultTab="about" />);
    await flushFetch();

    expect(screen.getByRole('heading', { name: 'About OneStreamer' })).toBeInTheDocument();
  });
});
