import { giveGas, isMember, MembershipAbi, roleAccount, send, type App } from '@openmutual/shared';
import { simulatedMembers } from './tick';

/** Adds the pretend members to the chain. Safe to run again. */
export async function seedSimulatedMembers(app: App) {
  for (const member of simulatedMembers()) {
    await giveGas(app.client, member.address);
    if (await isMember(app, member.address)) continue;
    await send(app.client, roleAccount('verifier'), { address: app.addresses.members, abi: MembershipAbi, functionName: 'add', args: [member.address] });
  }
}
