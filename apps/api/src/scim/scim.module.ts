import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OrganizationsModule } from '../organizations';
import { ScimController } from './scim.controller';
import { ScimService } from './scim.service';

/** Roadmap 14b — SCIM 2.0 provisioning (`docs/phase14/DIRECTORY-SYNC.md` §1). */
@Module({
  imports: [AuthModule, OrganizationsModule],
  controllers: [ScimController],
  providers: [ScimService],
})
export class ScimModule {}
