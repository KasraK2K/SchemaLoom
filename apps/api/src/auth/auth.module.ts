import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { MailModule } from '../mail/mail.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { GoogleAuthGuard } from './google-auth.guard';
import { googleStrategyProvider } from './google.strategy';
import { JwtAuthGuard } from './jwt-auth.guard';
import { TokensService } from './tokens.service';
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
 * run the Google redirect dance. Everything else is cookies and `JwtAuthGuard`.
 *
 * NOT built in Phase 1 (open question Q28, accepted): magic link, GitHub OAuth, TOTP,
 * recovery codes, device-session management. Their seams: `VerificationPurpose.magic_link`
 * already has a TTL in `VERIFICATION_TTL_SEC`; a GitHub strategy is a copy of
 * `googleStrategyProvider` with the other two env vars; the device list is a
 * `DISTINCT ON (family_id)` query over the rows `TokensService` already writes, and
 * "log out other devices" is `revokeAllForUser` minus the current family.
 */
@Module({
  imports: [PassportModule.register({ session: false }), JwtModule.register({}), MailModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokensService,
    VerificationService,
    JwtAuthGuard,
    GoogleAuthGuard,
    googleStrategyProvider,
  ],
  exports: [JwtAuthGuard, AuthService, TokensService],
})
export class AuthModule {}
