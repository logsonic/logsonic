import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OptionsTab } from '../OptionsTab';
import { ISO8601_HEADER_PATTERN } from '../../utils/multilinePresets';

import { useImportStore } from '@/stores/useImportStore';

beforeEach(() => useImportStore.getState().reset());

describe('OptionsTab multiline selection', () => {
  it('clears the automatic marker when a detected preset is explicitly selected again', () => {
    useImportStore.getState().addNativePathFiles(['/abs/app.log']);
    const file = useImportStore.getState().files[0];
    useImportStore.getState().updateFileSessionOptions(file.id, {
      multiline: { enabled: true, mode: 'header', headerPattern: ISO8601_HEADER_PATTERN, autoDetected: true },
    });
    const detected = useImportStore.getState().files[0];
    render(<OptionsTab file={detected} fileCount={1} onReparse={vi.fn(async () => {})} />);
    fireEvent.click(screen.getByRole('button', { name: 'ISO8601' }));
    expect(useImportStore.getState().files[0].sessionOptions.multiline.autoDetected).toBeUndefined();
  });

  it('clears the automatic marker when the header regex is edited', () => {
    useImportStore.getState().addNativePathFiles(['/abs/app.log']);
    const file = useImportStore.getState().files[0];
    useImportStore.getState().updateFileSessionOptions(file.id, {
      multiline: { enabled: true, mode: 'header', headerPattern: '^START', autoDetected: true },
    });
    const detected = useImportStore.getState().files[0];
    const view = render(<OptionsTab file={detected} fileCount={1} onReparse={vi.fn(async () => {})} />);
    fireEvent.change(screen.getByLabelText('New-record regex'), { target: { value: '^NEXT' } });
    expect(useImportStore.getState().files[0].sessionOptions.multiline).toEqual({
      enabled: true, mode: 'header', headerPattern: '^NEXT',
    });
    view.unmount();
  });
});
