import { displayName, playerDto } from './players.repository.js';

describe('player display projection', () => {
  it('keeps abbreviated names without disclosing private fields', () => {
    const player = {
      name: 'Long',
      lastname: 'Thomas',
      email: 'private@test.invalid',
      fcmToken: ['secret'],
      lastScreenTime: new Date('2026-11-14T10:00:00Z'),
    };
    expect(displayName(player)).toBe('Thomas L.');
    const publicPlayer = playerDto(player, 'id');
    expect(publicPlayer.displayName).toBe('Thomas L.');
    expect(publicPlayer).not.toHaveProperty('name');
    expect(publicPlayer).not.toHaveProperty('lastname');
    expect(publicPlayer).not.toHaveProperty('email');
    expect(publicPlayer).not.toHaveProperty('fcmToken');
    expect(publicPlayer).not.toHaveProperty('lastScreenTime');
    expect(playerDto(player, 'id', true)).toHaveProperty(
      'lastScreenTime',
      '2026-11-14T10:00:00.000Z',
    );
  });
  it('accepts optional first names and malformed legacy fields', () => {
    expect(displayName({ name: 'long', lastname: '' })).toBe('Long');
    expect(displayName({ name: null, lastname: {} })).toBe('Joueur');
  });
});
