import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { toEnvelope } from './all-exceptions.filter';

describe('toEnvelope', () => {
  it('lower-cases the code and falls back to the exception message', () => {
    expect(toEnvelope(new ConflictException({ code: 'EMAIL_TAKEN' }))).toEqual([
      409,
      { code: 'email_taken', message: 'Conflict Exception' },
    ]);
  });

  it('moves extra fields into details', () => {
    const [, body] = toEnvelope(new ForbiddenException({ code: 'forbidden', atom: 'schema:edit' }));
    expect(body).toEqual({
      code: 'forbidden',
      message: 'Forbidden Exception',
      details: { atom: 'schema:edit' },
    });
  });

  it('derives a code from the status when the throw site gave none', () => {
    expect(toEnvelope(new NotFoundException())[1].code).toBe('not_found');
    const [, body] = toEnvelope(
      new BadRequestException({
        statusCode: 400,
        message: 'Validation failed',
        errors: [{ path: ['name'] }],
      }),
    );
    expect(body).toEqual({
      code: 'bad_request',
      message: 'Validation failed',
      details: { errors: [{ path: ['name'] }] },
    });
  });

  it('answers a non-HTTP error as an opaque 500', () => {
    expect(toEnvelope(new Error('relation "users" does not exist'))).toEqual([
      500,
      { code: 'internal', message: 'Something went wrong on our side.' },
    ]);
  });
});
