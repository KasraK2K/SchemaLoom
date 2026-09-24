import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '../generated/prisma/client';
import type { AppEnv } from '../config/env';

/**
 * Doc 01 §3: owns the `PrismaClient` lifecycle. The URL comes from `ConfigService`,
 * not from `process.env`, because `DATABASE_URL` is derived (see `config/database-url`)
 * and the derived value never reaches `process.env`.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(config: ConfigService<AppEnv, true>) {
    super({ datasourceUrl: config.get('DATABASE_URL', { infer: true }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
