import { Injectable, NotFoundException, type ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@nestjs/passport';
import type { Observable } from 'rxjs';
import type { AppEnv } from '../config/env';
import { isGoogleConfigured } from './google.strategy';

/**
 * Without this, a deployment with no Google credentials answers `/auth/google` with
 * passport's "Unknown authentication strategy" — a 500 on a route the operator simply
 * did not turn on. It is a 404: the button is not there, and neither is the route.
 */
@Injectable()
export class GoogleAuthGuard extends AuthGuard('google') {
  constructor(private readonly config: ConfigService<AppEnv, true>) {
    super();
  }

  override canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    if (!isGoogleConfigured(this.config)) throw new NotFoundException();
    return super.canActivate(context);
  }
}
