import type { SenderCapabilities } from '../contracts/sender';
import type { EmailAddress } from '../domain/addressing/email-address';
import type { Template } from '../domain/catalog/template';
import type { Message } from '../domain/messaging/message';

export function connectionCapabilityProblem(
  capabilities: SenderCapabilities,
  cc: readonly EmailAddress[] | undefined,
  template: Template,
): string | undefined {
  const ccCount = cc?.length ?? 0;

  if (ccCount > 0 && !capabilities.cc) {
    return 'its integration cannot send CC, and this list has a CC';
  }

  if (capabilities.maxCc !== undefined && ccCount > capabilities.maxCc) {
    return `its integration accepts at most ${String(capabilities.maxCc)} CC, and this list has ${String(ccCount)}`;
  }

  if (template.saveToSentItems === true && capabilities.sentCopy === 'never') {
    return 'the template asks to save a copy in Sent Items, and its integration never keeps one';
  }

  return undefined;
}

export function messageCapabilityProblem(capabilities: SenderCapabilities, message: Message): string | undefined {
  return (message.inlineAttachments?.length ?? 0) > 0 && !capabilities.inlineAttachments
    ? 'the message has inline images, and its integration cannot send them'
    : undefined;
}
