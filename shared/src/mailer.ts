/** Sends login codes. The real thing is an email service. Today only this local fake exists. */
export interface Mailer {
  name: string;
  /** True when the code has to be shown on screen because no email was really sent. */
  showsCodeOnScreen: boolean;
  sendCode(email: string, code: string): Promise<void>;
}

export function fakeMailer(): Mailer {
  return { name: 'fake-mail', showsCodeOnScreen: true, async sendCode() {} };
}
