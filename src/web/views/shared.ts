// What every view hands the router.

export interface View {
  root: HTMLElement;
  title: string;
  dispose?: () => void;
}
