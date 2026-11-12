/** 발송 경계를 분리한다. 현재는 암호화한 보류 메일만 저장하며 외부 메일 서버에 접속하지 않는다. */
import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { PoolClient } from 'pg';
import { settings } from './config';
export type MailContent = { to: string; subject: string; text: string };
// 용도 문자열을 섞어 세션 서명 키를 암호화 키로 직접 재사용하지 않는다. 키 교체 시 보류 메일도 재발급한다.
const key = () =>
  createHash('sha256')
    .update('cpjt-mail-outbox:' + settings.secret)
    .digest();
export function openMail(payload: string): MailContent {
  const [iv, tag, content] = payload.split('.').map((v) => Buffer.from(v, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(content), decipher.final()]).toString('utf8'));
}
@Injectable()
export class Mail {
  /** 계정 변경과 같은 트랜잭션으로 보류 메일을 기록해 실패 시 링크·메일이 함께 롤백되게 한다. */
  async hold(c: PoolClient, userId: string, content: MailContent) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key(), iv);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(content), 'utf8'),
      cipher.final(),
    ]);
    const payload = [iv, cipher.getAuthTag(), encrypted].map((v) => v.toString('base64')).join('.');
    await c.query(
      `INSERT INTO app.mail_outbox(user_id,payload,expires_at) VALUES($1,$2,now()+interval '30 minutes')`,
      [userId, payload],
    );
  }
}
