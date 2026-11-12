/**
 * 업체(워크스페이스)별 SLA 설정. 우선순위마다 첫 응답 기한과 처리 기한(시간)을 정한다.
 * 설정 행이 없는 우선순위는 기본값을 쓰며, 변경은 이후 등록되는 요청부터 적용한다(이미 등록된 요청의 기한은 그대로).
 * 기한은 달력 시간 기준이다(주말·업무 시간 제외는 후속 범위). 관련: requests.ts(등록 시 기한 계산), 015 마이그레이션.
 */
import { Body, ConflictException, Controller, Get, Injectable, Post, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { PoolClient } from 'pg';
import { Db } from './db';
import { Audit } from './audit';
import { AppRequest, Permission } from './security';

export const PRIORITIES = ['URGENT', 'HIGH', 'NORMAL', 'LOW'] as const;
// 설정하지 않은 업체의 기본값(시간). 처리 기한은 기존 고정 규칙과 같다.
export const SLA_DEFAULTS: Record<string, { response: number; resolve: number }> = {
  URGENT: { response: 1, resolve: 4 },
  HIGH: { response: 4, resolve: 24 },
  NORMAL: { response: 8, resolve: 72 },
  LOW: { response: 24, resolve: 168 },
};

/** 현재 워크스페이스의 우선순위 SLA(시간). 호출자의 트랜잭션 안에서 RLS로 자기 업체 설정만 읽는다. */
export async function slaFor(c: PoolClient, priority: string) {
  const row = (
    await c.query('SELECT response_hours,resolve_hours FROM app.sla_policies WHERE priority=$1', [
      priority,
    ])
  ).rows[0];
  return row
    ? { response: row.response_hours as number, resolve: row.resolve_hours as number }
    : SLA_DEFAULTS[priority];
}

class SlaRow {
  @IsIn(PRIORITIES) priority!: string;
  @IsInt() @Min(1) @Max(8760) responseHours!: number;
  @IsInt() @Min(1) @Max(8760) resolveHours!: number;
  // 저장된 행을 고칠 때만 보낸다. 없으면 새 설정(기본값을 덮어씀)으로 본다.
  @IsOptional() @IsInt() @Min(1) version?: number;
}
class SlaSaveDto {
  // ValidateNested + Type: 배열 안의 각 객체도 SlaRow 규칙으로 검사한다.
  @IsArray() @ArrayMaxSize(4) @ValidateNested({ each: true }) @Type(() => SlaRow) rows!: SlaRow[];
}

@Injectable()
export class Sla {
  constructor(
    private readonly db: Db,
    private readonly audit: Audit,
  ) {}
  /** 우선순위 4개를 항상 돌려준다. 저장된 값이 없으면 기본값과 custom=false를 함께 준다. */
  async list() {
    return this.db.tx(async (c) => {
      const saved = new Map(
        (await c.query('SELECT * FROM app.sla_policies')).rows.map((r) => [r.priority, r]),
      );
      return {
        items: PRIORITIES.map((p) => {
          const r = saved.get(p);
          return {
            priority: p,
            responseHours: r ? r.response_hours : SLA_DEFAULTS[p].response,
            resolveHours: r ? r.resolve_hours : SLA_DEFAULTS[p].resolve,
            version: r ? r.version : null,
            custom: Boolean(r),
          };
        }),
      };
    });
  }
  /** 체크된 행만 저장한다. 한 행이라도 규칙 위반·버전 충돌이면 전체를 롤백한다. */
  async save(req: AppRequest, body: SlaSaveDto) {
    if (req.actor!.authority_type !== 'SYSTEM')
      throw new ConflictException('업체 계정만 설정할 수 있습니다.');
    return this.db.tx(async (c) => {
      for (const row of body.rows) {
        if (row.responseHours > row.resolveHours)
          throw new ConflictException('첫 응답 기한은 처리 기한보다 길 수 없습니다.');
        if (row.version) {
          const r = await c.query(
            'UPDATE app.sla_policies SET response_hours=$2,resolve_hours=$3,updated_at=now() WHERE priority=$1 AND version=$4',
            [row.priority, row.responseHours, row.resolveHours, row.version],
          );
          if (!r.rowCount)
            throw new ConflictException('다른 사용자가 먼저 변경했습니다. 다시 조회해주세요.');
        } else {
          // 기본값을 쓰던 우선순위의 첫 저장. 동시에 다른 사람이 먼저 저장했다면 충돌로 거절한다.
          const r = await c.query(
            'INSERT INTO app.sla_policies(priority,response_hours,resolve_hours) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
            [row.priority, row.responseHours, row.resolveHours],
          );
          if (!r.rowCount)
            throw new ConflictException('다른 사용자가 먼저 변경했습니다. 다시 조회해주세요.');
        }
      }
      await this.audit.write(
        {
          requestId: req.requestId,
          userId: req.actor!.id,
          menuId: req.get('x-menu-id'),
          action: 'SLA_SAVE',
          outcome: 'SUCCESS',
        },
        c,
      );
      return { message: 'SLA를 저장했습니다. 이후 등록되는 요청부터 적용됩니다.' };
    });
  }
}

@Controller('api/sla')
export class SlaController {
  constructor(private readonly sla: Sla) {}
  @Get() @Permission('SLA_SETTINGS', 'QUERY') list() {
    return this.sla.list();
  }
  @Post() @Permission('SLA_SETTINGS', 'SAVE') save(
    @Req() req: AppRequest,
    @Body() body: SlaSaveDto,
  ) {
    return this.sla.save(req, body);
  }
}
