import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api-client';
import { flowBounds } from './canvas-image';
import { exportErrorMessage } from './exports-api';

describe('flowBounds', () => {
  it('spans every card, including negative positions', () => {
    expect(
      flowBounds([
        { x: -40, y: 10, width: 200, height: 100 },
        { x: 300, y: -20, width: 180, height: 60 },
      ]),
    ).toEqual({ x: -40, y: -20, width: 520, height: 130 });
  });

  it('is null for an empty canvas', () => {
    expect(flowBounds([])).toBeNull();
  });
});

describe('exportErrorMessage', () => {
  it('names the missing access on a 403', () => {
    expect(exportErrorMessage(new ApiError(403, 'forbidden', 'Forbidden'))).toBe(
      "You don't have export access.",
    );
  });

  it('passes other failures through', () => {
    expect(exportErrorMessage(new Error('The upload failed (500).'))).toBe(
      'The upload failed (500).',
    );
  });
});
