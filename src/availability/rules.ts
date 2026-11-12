import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
export type SlotInput = {
  start: string;
  end: string;
  sports: ('Tennis' | 'Padel')[];
  location: { stade: string; city: string; nbRequis: number };
};
export function parisDay(date: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return {
    day: `${part('year')}-${part('month')}-${part('day')}`,
    hour: Number(part('hour')),
  };
}
export function parisDayBounds(day: string) {
  const midnight = (date: Date) => {
    const offset = new Intl.DateTimeFormat('en', {
      timeZone: 'Europe/Paris',
      timeZoneName: 'longOffset',
    })
      .formatToParts(date)
      .find((p) => p.type === 'timeZoneName')!.value;
    const match = /GMT([+-])(\d{2}):(\d{2})/.exec(offset)!;
    const minutes =
      (Number(match[2]) * 60 + Number(match[3])) * (match[1] === '+' ? 1 : -1);
    return new Date(date.getTime() - minutes * 60000);
  };
  const date = new Date(`${day}T00:00:00Z`),
    next = new Date(date);
  next.setUTCDate(next.getUTCDate() + 1);
  return { start: midnight(date), end: midnight(next) };
}
export function validateSlot(slot: SlotInput, now = new Date()) {
  const start = new Date(slot.start),
    end = new Date(slot.end);
  const local = parisDay(start),
    today = parisDay(now).day;
  const maxDay = new Date(`${today}T12:00:00Z`);
  maxDay.setUTCDate(maxDay.getUTCDate() + 14);
  if (
    start <= now ||
    local.day < today ||
    local.day > maxDay.toISOString().slice(0, 10) ||
    local.hour < 8 ||
    local.hour > 21 ||
    start.getUTCMinutes() ||
    start.getUTCSeconds() ||
    start.getUTCMilliseconds() ||
    end.getTime() - start.getTime() !== 3600000
  )
    throw new BadRequestException({ code: 'SLOT_INVALID_TIME' });
  if (slot.sports.length !== 1 || !['Tennis', 'Padel'].includes(slot.sports[0]))
    throw new BadRequestException({ code: 'SLOT_SPORT_REQUIRED' });
  if (!slot.location.stade.trim() || !slot.location.city.trim())
    throw new BadRequestException({ code: 'SLOT_LOCATION_REQUIRED' });
  if (
    !Number.isInteger(slot.location.nbRequis) ||
    slot.location.nbRequis < 1 ||
    slot.location.nbRequis > (slot.sports[0] === 'Padel' ? 3 : 1)
  )
    throw new BadRequestException({ code: 'SLOT_INVALID_PLAYERS' });
}
export function slotResponse(
  data: Record<string, any>,
  ownerUid: string,
  accept: boolean,
) {
  if (data.ownerUid !== ownerUid) throw new ForbiddenException();
  if (data.status !== 'PENDING' || !data.opponentUid)
    throw new ConflictException({ code: 'SLOT_NOT_PENDING' });
  const participants: string[] = data.participants ?? [data.ownerUid];
  const remaining = Number(data.location?.nbRequis ?? 1);
  if (!accept)
    return {
      status: 'AVAILABLE',
      participants: participants.filter((p) => p !== data.opponentUid),
    };
  if (!Number.isInteger(remaining) || remaining < 1)
    throw new ConflictException({ code: 'SLOT_FULL' });
  return {
    status: remaining > 1 ? 'AVAILABLE' : 'ACCEPTED',
    participants,
    'location.nbRequis': remaining - 1,
  };
}
