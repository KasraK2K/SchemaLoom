import { Injectable, NotFoundException, type ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@nestjs/passport';
import type { Observable } from 'rxjs';
import type { AppEnv } from '../config/env';
import { isGitHubConfigured } from './github.strategy';

/** `GoogleAuthGuard`'s twin: an unconfigured provider is a 404, not passport's 500. */
@Injectable()
export class GitHubAuthGuard extends AuthGuard('github') {
  constructor(private readonly config: ConfigService<AppEnv, true>) {
    super();
  }

  override canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    if (!isGitHubConfigured(this.config)) throw new NotFoundException();
    return super.canActivate(context);
  }
}
