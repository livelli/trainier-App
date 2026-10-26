import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeUrl, parseCallback, uploadState, redirectUri } from '../js/strava.js';

test('Anmelde-Adresse mit Upload-Recht und Rücksprung auf die App', () => {
  const url = new URL(authorizeUrl('12345', 'https://livelli.github.io/trainier-App/', 'trainer-app-strava-abc'));
  assert.equal(url.searchParams.get('state'), 'trainer-app-strava-abc');
  assert.equal(url.origin + url.pathname, 'https://www.strava.com/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), '12345');
  assert.equal(url.searchParams.get('scope'), 'activity:write');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://livelli.github.io/trainier-App/');
  assert.equal(url.searchParams.get('response_type'), 'code');
});

test('Rücksprung-Adresse ohne alte Parameter', () => {
  assert.equal(redirectUri({ origin: 'https://livelli.github.io', pathname: '/trainier-App/' }), 'https://livelli.github.io/trainier-App/');
});

test('Antwort von Strava auslesen', () => {
  const st = 'trainer-app-strava-abc';
  assert.equal(parseCallback('', st), null);
  assert.equal(parseCallback('?code=abc', st), null); // fremder Aufruf ohne unseren state
  assert.deepEqual(parseCallback(`?state=${st}&code=abc&scope=read,activity:write`, st), { code: 'abc' });
  assert.match(parseCallback(`?state=${st}&code=abc&scope=read`, st).error, /Häkchen/);
  assert.match(parseCallback(`?state=${st}&error=access_denied`, st).error, /abgelehnt/);
  // untergeschobener Link mit fremdem state
  assert.match(parseCallback('?state=trainer-app-strava-xyz&code=evil&scope=activity:write', st).error, /passt nicht/);
  assert.match(parseCallback('?state=trainer-app-strava-xyz&code=evil&scope=activity:write', null).error, /passt nicht/);
});

test('Upload-Status: fertig, Duplikat, Fehler, läuft', () => {
  assert.deepEqual(uploadState({ id: 1, activity_id: 99, status: 'Your activity is ready.' }), { done: true, activityId: 99 });
  assert.deepEqual(uploadState({ id: 1, error: 'fahrt-1.fit duplicate of activity 1234567890' }), { done: true, activityId: 1234567890, duplicate: true });
  assert.deepEqual(uploadState({ id: 1, error: "duplicate of <a href='/activities/1234567890' target='_blank'>Lauf</a>" }), { done: true, activityId: 1234567890, duplicate: true });
  assert.deepEqual(uploadState({ id: 1, error: 'Improperly formatted <b>data</b>.' }), { done: true, error: 'Improperly formatted data.' });
  assert.deepEqual(uploadState({ id: 1, status: 'Your activity is still being processed.', error: null, activity_id: null }), { done: false });
});
