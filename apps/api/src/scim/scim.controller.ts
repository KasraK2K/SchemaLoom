import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UnauthorizedException,
  UseFilters,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequireScimToken } from '../access';
import type { ScimPrincipal } from '../auth/subject';
import { RESOURCE_TYPES, SCHEMAS, SERVICE_PROVIDER_CONFIG } from './scim.discovery';
import { ScimExceptionFilter } from './scim.filter';
import { SCHEMA } from './scim.protocol';
import { ScimService } from './scim.service';

const SCIM_JSON = 'application/scim+json';

/** `JwtAuthGuard` set it; `PermissionGuard` refused the route without it. */
function scimOf(req: Request): ScimPrincipal {
  if (req.scim === undefined) throw new UnauthorizedException({ code: 'invalid_token' });
  return req.scim;
}

const listOf = (resources: unknown[]) => ({
  schemas: [SCHEMA.list],
  totalResults: resources.length,
  startIndex: 1,
  itemsPerPage: resources.length,
  Resources: resources,
});

/**
 * Roadmap 14b §1.2 (`docs/phase14/DIRECTORY-SYNC.md`) — SCIM 2.0 for the IdP of one SSO
 * connection. Every route is `@RequireScimToken()`; the token's connection fixes the org,
 * so no route takes an org id. Errors are in the SCIM shape (`ScimExceptionFilter`).
 */
@ApiExcludeController()
@UseFilters(ScimExceptionFilter)
@Controller('scim/v2')
export class ScimController {
  constructor(private readonly scim: ScimService) {}

  // --------------------------------------------------------------------- discovery

  @RequireScimToken()
  @Header('content-type', SCIM_JSON)
  @Get('ServiceProviderConfig')
  serviceProviderConfig(): unknown {
    return SERVICE_PROVIDER_CONFIG;
  }

  @RequireScimToken()
  @Header('content-type', SCIM_JSON)
  @Get('ResourceTypes')
  resourceTypes(): unknown {
    return listOf(RESOURCE_TYPES);
  }

  @RequireScimToken()
  @Header('content-type', SCIM_JSON)
  @Get('Schemas')
  schemas(): unknown {
    return listOf(SCHEMAS);
  }

  // ------------------------------------------------------------------------- Users

  @RequireScimToken()
  @Header('content-type', SCIM_JSON)
  @Get('Users')
  listUsers(@Req() req: Request, @Query() query: Record<string, unknown>): Promise<unknown> {
    return this.scim.listUsers(scimOf(req), query);
  }

  @RequireScimToken()
  @Header('content-type', SCIM_JSON)
  @Post('Users')
  createUser(@Req() req: Request, @Body() body: unknown): Promise<unknown> {
    return this.scim.createUser(scimOf(req), body);
  }

  @RequireScimToken()
  @Header('content-type', SCIM_JSON)
  @Get('Users/:id')
  getUser(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.scim.getUser(scimOf(req), id);
  }

  @RequireScimToken()
  @Header('content-type', SCIM_JSON)
  @Put('Users/:id')
  replaceUser(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.scim.replaceUser(scimOf(req), id, body);
  }

  @RequireScimToken()
  @Header('content-type', SCIM_JSON)
  @Patch('Users/:id')
  patchUser(@Req() req: Request, @Param('id') id: string, @Body() body: unknown): Promise<unknown> {
    return this.scim.patchUser(scimOf(req), id, body);
  }

  @RequireScimToken()
  @HttpCode(204)
  @Delete('Users/:id')
  deleteUser(@Req() req: Request, @Param('id') id: string): Promise<void> {
    return this.scim.deleteUser(scimOf(req), id);
  }

  // ------------------------------------------------------------------------ Groups

  @RequireScimToken()
  @Header('content-type', SCIM_JSON)
  @Get('Groups')
  listGroups(@Req() req: Request, @Query() query: Record<string, unknown>): Promise<unknown> {
    return this.scim.listGroups(scimOf(req), query);
  }

  @RequireScimToken()
  @Header('content-type', SCIM_JSON)
  @Post('Groups')
  createGroup(@Req() req: Request, @Body() body: unknown): Promise<unknown> {
    return this.scim.createGroup(scimOf(req), body);
  }

  @RequireScimToken()
  @Header('content-type', SCIM_JSON)
  @Get('Groups/:id')
  getGroup(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.scim.getGroup(scimOf(req), id);
  }

  @RequireScimToken()
  @Header('content-type', SCIM_JSON)
  @Put('Groups/:id')
  replaceGroup(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.scim.replaceGroup(scimOf(req), id, body);
  }

  @RequireScimToken()
  @Header('content-type', SCIM_JSON)
  @Patch('Groups/:id')
  patchGroup(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.scim.patchGroup(scimOf(req), id, body);
  }

  @RequireScimToken()
  @HttpCode(204)
  @Delete('Groups/:id')
  deleteGroup(@Req() req: Request, @Param('id') id: string): Promise<void> {
    return this.scim.deleteGroup(scimOf(req), id);
  }
}
