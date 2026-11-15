/**
 * 고객 요청 첨부 파일 목록·올리기·내려받기(고객 요청 화면과 요청 작업함이 함께 쓴다).
 * 서버 경로: requests/{portal|desk}/:요청ID/attachments. 권한·업체 분리·내부용 숨김은 서버(requests.ts)가 판단하고,
 * 이 화면은 서버가 돌려준 목록만 보여 준다. 관련: api.ts의 upload·download.
 */
import { useRef, useState } from 'react';
import { download, upload } from './api';
import { Notify } from './Toasts';
import { dateTime } from './srLabels';

export type Attachment = {
  id: string;
  file_name: string;
  size_bytes: number;
  internal: boolean;
  created_at: string;
  uploader_name: string;
};
// 파일 크기를 읽기 쉬운 단위로 바꾼다(예: 1536 → 1.5KB).
// 요청 등록 화면(SrPortalScreen)의 '함께 올릴 파일' 목록도 같은 표기를 쓰도록 내보낸다(QA DLV2-014: 68바이트가 0KB로 보임).
export const sizeText = (n: number) =>
  n < 1024 ? n + 'B' : n < 1048576 ? (n / 1024).toFixed(1) + 'KB' : (n / 1048576).toFixed(1) + 'MB';

// 서버(requests.ts)와 같은 첨부 제한. 서버가 최종 판단하지만, 큰 파일을 다 올린 뒤에야 거절되면
// 수십 초를 기다리게 되므로 고르는 즉시 여기서 먼저 걸러 전송하지 않는다(QA 4차 DV4-003).
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const BLOCKED_EXT = /\.(exe|com|bat|cmd|scr|msi|dll|ps1|vbs|js|jse|wsf|jar|sh|lnk|hta)$/i;
/** 첨부할 수 없는 파일이면 이유 문장을, 괜찮으면 null을 돌려준다. 여러 개면 첫 번째 문제만 알린다. */
export function fileProblem(files: File[]): string | null {
  for (const f of files) {
    if (BLOCKED_EXT.test(f.name))
      return `${f.name}: 실행 파일·스크립트는 첨부할 수 없습니다. 압축하거나 다른 형식으로 올려 주세요.`;
    if (f.size > MAX_FILE_BYTES)
      return `${f.name}(${sizeText(f.size)}): 파일당 10MB까지 첨부할 수 있습니다.`;
  }
  return null;
}

/**
 * base: 'requests/portal/12' 또는 'requests/desk/12'. menuId: 화면 권한 확인용(X-Menu-ID).
 * canUpload: 저장 권한이 있고 요청이 끝나지 않았을 때만 true. allowInternal: 업체 화면에서만 '내부용' 선택을 보인다.
 * onChanged: 올리기가 끝나면 상세를 다시 읽어 목록과 처리 이력을 갱신한다.
 */
export function Attachments(props: {
  base: string;
  menuId: string;
  files: Attachment[];
  canUpload: boolean;
  allowInternal?: boolean;
  onChanged: () => Promise<void>;
  notify: Notify;
}) {
  const [busy, setBusy] = useState(false);
  const [internal, setInternal] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const headers = { 'X-Menu-ID': props.menuId };
  async function send(list: FileList | null) {
    if (!list?.length) return;
    // 하나라도 문제가 있으면 아무것도 올리지 않는다(일부만 올라가 헷갈리지 않게).
    const problem = fileProblem(Array.from(list));
    if (problem) {
      props.notify(problem, 'error');
      if (input.current) input.current.value = '';
      return;
    }
    setBusy(true);
    try {
      // 서버는 한 번에 파일 하나를 받으므로 고른 파일을 차례로 올린다. 중간에 실패하면 앞의 파일은 남는다.
      for (const f of Array.from(list)) {
        const form = new FormData();
        form.append('file', f);
        if (props.allowInternal && internal) form.append('internal', 'true');
        await upload(props.base + '/attachments', form, headers);
      }
      props.notify(`파일 ${list.length}개를 첨부했습니다.`, 'success');
    } catch (e) {
      props.notify((e as Error).message, 'error');
    } finally {
      if (input.current) input.current.value = '';
      await props.onChanged().catch(() => undefined);
      setBusy(false);
    }
  }
  return (
    <div className="sr-files">
      <strong>첨부 파일 {props.files.length ? `(${props.files.length})` : ''}</strong>
      {props.files.length > 0 && (
        <ul>
          {props.files.map((f) => (
            <li key={f.id}>
              <button
                type="button"
                className="link-button"
                onClick={() =>
                  download(`${props.base}/attachments/${f.id}`, f.file_name, headers).catch((e) =>
                    props.notify((e as Error).message, 'error'),
                  )
                }
              >
                {f.file_name}
              </button>
              <small>
                {sizeText(f.size_bytes)} · {f.uploader_name} · {dateTime(f.created_at)}
                {f.internal ? ' · 내부용' : ''}
              </small>
            </li>
          ))}
        </ul>
      )}
      {props.canUpload && (
        <div className="sr-files-add">
          {/* 기본 파일 칸은 모양이 다른 화면과 어울리지 않아 숨기고, 버튼 모양 라벨을 누르면 파일 고르기 창이 열린다(QA DL-025).
              multiple: 여러 파일을 한 번에 고를 수 있다. 휴대폰에서는 사진 촬영·앨범 선택도 이 버튼으로 된다. */}
          <label className={'file-button' + (busy ? ' disabled' : '')}>
            {busy ? '올리는 중…' : props.files.length ? '파일 더 첨부' : '파일 첨부'}
            <input
              ref={input}
              type="file"
              multiple
              disabled={busy}
              className="visually-hidden"
              onChange={(e) => void send(e.target.files)}
            />
          </label>
          {props.allowInternal && (
            <label className="sr-check">
              <input
                type="checkbox"
                checked={internal}
                onChange={(e) => setInternal(e.target.checked)}
              />
              내부용(고객에게 보이지 않음)
            </label>
          )}
          <small>파일당 10MB, 요청당 20개까지. 실행 파일은 올릴 수 없습니다.</small>
        </div>
      )}
    </div>
  );
}
