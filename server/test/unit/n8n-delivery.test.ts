import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deliveryAccepted, resolveDeliveryUrl } from '../../src/services/n8n-delivery.js';

/**
 * The email reset looked sent because the webhook URL n8n printed was the
 * website. These pin the two decisions that stop that: which URLs are really
 * this deployment's n8n, and which HTTP answers count as a delivery.
 */

const internal = { publicHost: '132-145-10-20.sslip.io', internalBase: 'http://n8n:5678' };

describe('a webhook URL that belongs to this deployment', () => {
  test('the old /n8n path on the app host is the website, so it is rewritten', () => {
    assert.equal(
      resolveDeliveryUrl('https://132-145-10-20.sslip.io/n8n/webhook/email-reset', internal),
      'http://n8n:5678/webhook/email-reset',
    );
  });

  test('the public n8n hostname is called on the compose network instead', () => {
    assert.equal(
      resolveDeliveryUrl('https://n8n.132-145-10-20.sslip.io/webhook/email-reset', internal),
      'http://n8n:5678/webhook/email-reset',
    );
  });

  test('the compose-internal address is left on n8n', () => {
    assert.equal(
      resolveDeliveryUrl('http://n8n:5678/webhook/whatsapp-reset', internal),
      'http://n8n:5678/webhook/whatsapp-reset',
    );
  });

  test('the laptop hostname is rewritten the same way', () => {
    assert.equal(
      resolveDeliveryUrl('http://n8n.localhost/webhook/email-reset', internal),
      'http://n8n:5678/webhook/email-reset',
    );
  });

  test('a query string survives the rewrite', () => {
    assert.equal(
      resolveDeliveryUrl('https://132-145-10-20.sslip.io/n8n/webhook/email-reset?x=1', internal),
      'http://n8n:5678/webhook/email-reset?x=1',
    );
  });
});

describe('a webhook URL that is not this deployment', () => {
  test('another host is left untouched', () => {
    const external = 'https://automation.example.com/webhook/email-reset';
    assert.equal(resolveDeliveryUrl(external, internal), external);
  });

  test('the test stub on 127.0.0.1 is left untouched', () => {
    const stub = 'http://127.0.0.1:4321/webhook/email-reset';
    assert.equal(resolveDeliveryUrl(stub, internal), stub);
  });

  test('the editor test URL is not a production webhook', () => {
    const testUrl = 'https://n8n.132-145-10-20.sslip.io/webhook-test/email-reset';
    assert.equal(resolveDeliveryUrl(testUrl, internal), testUrl);
  });
});

describe('what counts as delivered', () => {
  test('n8n JSON is a delivery', () => {
    assert.equal(deliveryAccepted(200, 'application/json', '{"message":"Workflow was started"}'), true);
  });

  test('an empty 200 is a delivery', () => {
    assert.equal(deliveryAccepted(200, null, ''), true);
  });

  test('the website answering 200 is not a delivery', () => {
    assert.equal(deliveryAccepted(200, 'text/html', '<!doctype html><html></html>'), false);
    assert.equal(deliveryAccepted(200, null, '<!DOCTYPE html><html>'), false);
  });

  test('an error status is not a delivery', () => {
    assert.equal(deliveryAccepted(404, 'application/json', '{"message":"not found"}'), false);
    assert.equal(deliveryAccepted(500, 'text/plain', 'smtp down'), false);
  });
});
