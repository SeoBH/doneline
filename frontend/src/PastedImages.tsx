/**
 * 캡처 붙여넣기와 본문 속 이미지 표시(고객 요청 화면·요청 작업함 공용).
 * - 쓰는 중: 글 칸에 Ctrl+V(또는 끌어다 놓기)한 이미지를 칸 아래 미리보기로 보여 주고, 글 속에는 [이미지 1] 표시를 넣는다.
 *   미리보기는 모서리를 끌어(PC) 또는 작게/보통/크게 버튼으로(휴대폰) 보일 크기를 정한다.
 * - 저장할 때: 이미지를 첨부 파일로 올린 뒤 [이미지 1]을 [[이미지:파일이름|너비%]] 형식으로 바꿔 글과 함께 저장한다.
 * - 볼 때: 글 속 [[이미지:...]] 자리에 해당 첨부 이미지를 그 너비로 보여 주고, 누르면 크게 연다.
 * 글은 계속 일반 텍스트로 저장하므로 HTML이 끼어들 여지가 없다. 관련: Attachments.tsx(첨부 목록), api.ts(upload·download).
 */
import { useEffect, useRef, useState } from 'react';
import { upload } from './api';

export type Pasted = { n: number; file: File; url: string; width: number };
// 글 속 저장 형식. 파일 이름에는 ']'와 '|'가 들어가지 않게 만든다(아래 fileName).
const TOKEN = /\[\[이미지:([^|\]]+)\|(\d{1,3})\]\]/g;
const SIZES: [string, number][] = [
  ['작게', 30],
  ['보통', 60],
  ['크게', 100],
];
// 아주 큰 캡처는 올리기 전에 가로 1,600px로 줄인다(보기에는 충분하고 10MB 제한·전송 시간을 줄인다).
const MAX_PX = 1600;

/** 붙여 넣은 이미지를 '캡처-날짜시각-번호.png' 같은 겹치지 않는 이름의 파일로 만든다(필요하면 줄인다). */
async function prepare(src: File, n: number): Promise<File> {
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const ext = src.type === 'image/jpeg' ? 'jpg' : src.type === 'image/webp' ? 'webp' : 'png';
  const name = `캡처-${stamp}-${n}.${ext}`;
  try {
    // createImageBitmap: 파일을 그림으로 읽는다. 크면 캔버스에 줄여 다시 그린 뒤 파일로 만든다.
    const bmp = await createImageBitmap(src);
    if (bmp.width <= MAX_PX) return new File([src], name, { type: src.type || 'image/png' });
    const canvas = document.createElement('canvas');
    canvas.width = MAX_PX;
    canvas.height = Math.round((bmp.height * MAX_PX) / bmp.width);
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const type = src.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, type, 0.9));
    return new File([blob || src], name, { type: blob ? type : src.type });
  } catch {
    return new File([src], name, { type: src.type || 'image/png' });
  }
}

/**
 * 글 칸 하나에 붙는 붙여넣기 상태. text·setText는 그 칸의 글 상태다.
 * 반환값: onPaste·onDrop(글 칸에 연결), images(미리보기), setWidth·remove, commit(저장 직전 호출), reset.
 */
export function usePastedImages(text: string, setText: (v: string) => void) {
  const [images, setImages] = useState<Pasted[]>([]);
  const next = useRef(1);
  // 최신 목록을 ref에도 두어, 화면이 사라질 때(빈 의존성 effect의 정리 함수) 남은 미리보기 주소를 해제한다.
  const live = useRef<Pasted[]>([]);
  live.current = images;
  useEffect(() => () => live.current.forEach((i) => URL.revokeObjectURL(i.url)), []);
  async function add(files: File[], el?: HTMLTextAreaElement | null) {
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    if (!imgs.length) return false;
    const added: Pasted[] = [];
    for (const f of imgs) {
      const n = next.current++;
      const file = await prepare(f, n);
      added.push({ n, file, url: URL.createObjectURL(file), width: 60 });
    }
    // 커서 위치에 [이미지 n] 표시를 넣는다(커서를 모르면 글 끝).
    const marks = added.map((a) => `[이미지 ${a.n}]`).join(' ');
    const at = el ? el.selectionStart : text.length;
    setText(text.slice(0, at) + marks + text.slice(at));
    setImages((old) => [...old, ...added]);
    return true;
  }
  return {
    images,
    onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
      const files = Array.from(e.clipboardData.files);
      // 이미지가 있을 때만 기본 붙여넣기를 막는다(글자만 붙여 넣으면 그대로 둔다).
      if (files.some((f) => f.type.startsWith('image/'))) {
        e.preventDefault();
        void add(files, e.currentTarget);
      }
    },
    onDrop(e: React.DragEvent<HTMLTextAreaElement>) {
      const files = Array.from(e.dataTransfer.files);
      if (files.some((f) => f.type.startsWith('image/'))) {
        e.preventDefault();
        void add(files, e.currentTarget);
      }
    },
    setWidth(n: number, width: number) {
      setImages((old) => old.map((i) => (i.n === n ? { ...i, width } : i)));
    },
    remove(n: number) {
      const img = images.find((i) => i.n === n);
      if (img) URL.revokeObjectURL(img.url);
      setImages((old) => old.filter((i) => i.n !== n));
      setText(text.replace(`[이미지 ${n}]`, ''));
    },
    /**
     * 저장 형식으로 바꾼 글과, 실제로 올릴 이미지(글 속에 표시가 남아 있는 것만)를 돌려준다.
     * 파일 이름은 붙여 넣을 때 정해지므로 올리기 전에도 바꿀 수 있다(새 요청은 요청을 만든 뒤에 올린다).
     */
    tokens() {
      let out = text;
      const used: Pasted[] = [];
      for (const img of images) {
        const mark = `[이미지 ${img.n}]`;
        if (!out.includes(mark)) continue;
        out = out.replace(mark, `[[이미지:${img.file.name}|${img.width}]]`);
        used.push(img);
      }
      return { text: out, used };
    },
    /** 고른 이미지를 첨부로 올린다. 실패하면 예외를 던져 호출 쪽이 저장을 멈추거나 안내하게 한다. */
    async uploadAll(used: Pasted[], base: string, menuId: string, internal = false) {
      for (const img of used) {
        const form = new FormData();
        form.append('file', img.file);
        if (internal) form.append('internal', 'true');
        await upload(base + '/attachments', form, { 'X-Menu-ID': menuId });
      }
    },
    reset() {
      images.forEach((i) => URL.revokeObjectURL(i.url));
      setImages([]);
      next.current = 1;
    },
  };
}

/** 글 칸 아래 미리보기. 모서리를 끌거나 작게/보통/크게로 너비(글 칸 대비 %)를 정한다. */
export function PastePreview(props: {
  images: Pasted[];
  setWidth: (n: number, w: number) => void;
  remove: (n: number) => void;
}) {
  if (!props.images.length) return null;
  return (
    <div className="paste-preview">
      {props.images.map((img) => (
        <Resizable key={img.n} img={img} setWidth={props.setWidth} remove={props.remove} />
      ))}
      <small>
        이미지는 등록할 때 첨부 파일로 함께 올라갑니다. 글 속 [이미지 n] 표시 자리에 보입니다.
      </small>
    </div>
  );
}

function Resizable(props: {
  img: Pasted;
  setWidth: (n: number, w: number) => void;
  remove: (n: number) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  // CSS resize(오른쪽 아래 모서리 끌기)로 바뀐 너비를 읽어 부모 폭 대비 %로 저장한다.
  // ResizeObserver: 요소 크기가 바뀔 때마다 알려 주는 브라우저 기능.
  useEffect(() => {
    const el = box.current;
    if (!el?.parentElement) return;
    const ro = new ResizeObserver(() => {
      const pct = Math.round((el.offsetWidth / el.parentElement!.clientWidth) * 100);
      if (pct >= 10 && pct <= 100 && Math.abs(pct - props.img.width) > 2)
        props.setWidth(props.img.n, pct);
    });
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.img.n]);
  return (
    <figure>
      <div className="paste-box" ref={box} style={{ width: props.img.width + '%' }}>
        <img src={props.img.url} alt={`이미지 ${props.img.n}`} />
      </div>
      <figcaption>
        [이미지 {props.img.n}] {props.img.width}%
        {SIZES.map(([label, w]) => (
          <button key={w} type="button" onClick={() => props.setWidth(props.img.n, w)}>
            {label}
          </button>
        ))}
        <button type="button" onClick={() => props.remove(props.img.n)}>
          빼기
        </button>
      </figcaption>
    </figure>
  );
}

/**
 * 저장된 글을 보여 준다. [[이미지:파일이름|너비]] 자리에 같은 이름의 첨부 이미지를 그 너비로 넣는다.
 * 이미지는 권한 머리글(X-Menu-ID)을 붙여 받아야 해서 fetch로 받은 뒤 임시 주소로 표시한다.
 * 볼 권한이 없거나(고객이 보는 내부용 등) 지워진 파일이면 '[이미지]' 글자만 남긴다.
 */
export function ImageText(props: {
  text: string;
  files: { id: string; file_name: string }[];
  base: string;
  menuId: string;
}) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of props.text.matchAll(TOKEN)) {
    parts.push(props.text.slice(last, m.index));
    const f = props.files.find((x) => x.file_name === m[1]);
    parts.push(
      f ? (
        <AttachedImage
          key={m.index}
          url={`${props.base}/attachments/${f.id}`}
          menuId={props.menuId}
          width={Number(m[2])}
          name={m[1]}
        />
      ) : (
        '[이미지]'
      ),
    );
    last = m.index! + m[0].length;
  }
  parts.push(props.text.slice(last));
  return <>{parts}</>;
}

function AttachedImage(props: { url: string; menuId: string; width: number; name: string }) {
  const [src, setSrc] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let url = '';
    let alive = true;
    fetch('/api/' + props.url, { headers: { 'X-Menu-ID': props.menuId } })
      .then((r) => (r.ok ? r.blob() : Promise.reject()))
      .then((b) => {
        url = URL.createObjectURL(b);
        if (alive) setSrc(url);
      })
      .catch(() => undefined);
    // 화면에서 사라지면 받은 이미지의 임시 주소를 해제한다.
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [props.url, props.menuId]);
  if (!src) return <span className="hint">[이미지 불러오는 중]</span>;
  return (
    <>
      <img
        className="body-image"
        src={src}
        alt={props.name}
        style={{ width: Math.min(Math.max(props.width, 10), 100) + '%' }}
        onClick={() => setOpen(true)}
      />
      {/* 누르면 화면 가득 원래 크기로 보여 준다. 바깥을 누르거나 Esc로 닫는다. */}
      {open && (
        <div
          className="image-viewer"
          role="dialog"
          aria-label={props.name}
          tabIndex={-1}
          ref={(el) => el?.focus()}
          onClick={() => setOpen(false)}
          onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
        >
          <img src={src} alt={props.name} />
        </div>
      )}
    </>
  );
}
