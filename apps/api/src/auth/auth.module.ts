import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { MailModule } from '../mail/mail.module';
import { AuthController } from './auth.controller';
import { ApiTokenAuthService } from './api-token-auth.service';
import { AuthService } from './auth.service';
import { GitHubAuthGuard } from './github-auth.guard';
import { githubStrategyProvider } from './github.strategy';
import { GoogleAuthGuard } from './google-auth.guard';
import { googleStrategyProvider } from './google.strategy';
import { JwtAuthGuard } from './jwt-auth.guard';
import { SignupPolicy } from './signup-policy';
import { TokensService } from './tokens.service';
import { TwoFactorService } from './two-factor.service';
import { VerificationService } from './verification.service';

/**
 * Build-order step 9. Doc 01 §4: `AuthModule` imports `AccessModule`, never the reverse
 * — so nothing here imports from `src/access/`, and the resolver reads the principal
 * this module attaches through `getSubject(req)` in `./subject`.
 *
 * `JwtModule.register({})` on purpose: there are two secrets (`JWT_ACCESS_SECRET` and,
 * for refresh rotation, no JWT at all) and two audiences, so every sign/verify passes
 * its own options. A module-level default secret would be the one nobody notices being
 * used by mistake.
 *
 * `PassportModule` with no default strategy and no session: passport is here only to
 * run the Google and GitHub redirect dances. Everything else is cookies and `JwtAuthGuard`.
 *
 * Phase 3 (Q28's deferred set): magic link, GitHub OAuth, TOTP + recovery codes and the
 * device list. Every login path still ends in `AuthService.issueSession`, which is where
 * the 2FA gate sits.
 */
@Module({
  imports: [PassportModule.register({ session: false }), JwtModule.register({}), MailModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokensService,
    VerificationService,
    JwtAuthGuard,
    ApiTokenAuthService,
    TwoFactorService,
    SignupPolicy,
    GoogleAuthGuard,
    googleStrategyProvider,
    GitHubAuthGuard,
    githubStrategyProvider,
  ],
  exports: [JwtAuthGuard, AuthService, TokensService, SignupPolicy],
})
export class AuthModule {}
