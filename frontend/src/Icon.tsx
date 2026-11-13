/**
 * 화면에서 쓰는 작은 선(line) 아이콘 모음. 이모지는 기기·글꼴마다 모양과 크기가 달라 업무 화면에서 쓰지 않는다.
 * 모양은 Lucide 아이콘(MIT)과 같은 24px 격자의 선 아이콘이며, 색은 글자색(currentColor)을 따른다.
 * aria-hidden: 아이콘은 꾸밈이므로 화면 읽기 프로그램에는 버튼의 aria-label만 읽히게 한다.
 */
const paths: Record<string, string> = {
  bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9 M10.3 21a1.94 1.94 0 0 0 3.4 0',
  menu: 'M4 6h16 M4 12h16 M4 18h16',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9',
  message: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
};

export function Icon({ name, size = 18 }: { name: keyof typeof paths; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name].split(' M').map((d, i) => (
        <path key={i} d={i ? 'M' + d : d} />
      ))}
    </svg>
  );
}
