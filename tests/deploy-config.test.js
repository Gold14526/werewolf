import test from 'node:test';
import assert from 'node:assert/strict';
import {makeCloudflareConfig} from '../scripts/configure-cloudflare.mjs';

const base={CF_DATABASE_ID:'12345678-1234-4234-8234-123456789abc',GITHUB_REPOSITORY_OWNER:'Test-Owner'};

test('portable deployment binds the requested D1 database and GitHub Pages origin',()=>{
  const config=makeCloudflareConfig(base);
  assert.equal(config.name,'werewolf-api');
  assert.equal(config.main,'dist/server/index.js');
  assert.equal(config.vars.ALLOWED_ORIGINS,'https://test-owner.github.io');
  assert.equal(config.d1_databases[0].database_id,base.CF_DATABASE_ID);
  assert.equal(config.d1_databases[0].binding,'DB');
  assert.equal(config.d1_databases[0].migrations_dir,'drizzle');
  assert.equal('account_id' in config,false);
});

test('portable deployment validates resource identifiers rather than writing placeholders',()=>{
  assert.throws(()=>makeCloudflareConfig({}),/CF_DATABASE_ID/);
  assert.throws(()=>makeCloudflareConfig({...base,CF_DATABASE_ID:'not-created-yet'}),/CF_DATABASE_ID/);
  assert.throws(()=>makeCloudflareConfig({...base,WORKER_NAME:'../../other'}),/WORKER_NAME/);
  assert.throws(()=>makeCloudflareConfig({...base,CF_DATABASE_NAME:'db"\nunsafe'}),/CF_DATABASE_NAME/);
  assert.throws(()=>makeCloudflareConfig({...base,GITHUB_REPOSITORY_OWNER:'owner.github.io/evil'}),/GITHUB_REPOSITORY_OWNER/);
});

test('portable CORS accepts explicit HTTPS origins and rejects broad or credential-bearing URLs',()=>{
  const config=makeCloudflareConfig({...base,ALLOWED_ORIGINS:'https://play.example.com/, https://test-owner.github.io, https://play.example.com'});
  assert.equal(config.vars.ALLOWED_ORIGINS,'https://test-owner.github.io,https://play.example.com');
  for(const value of ['*','http://play.example.com','https://user:password@example.com','https://example.com/game','https://example.com/?secret=1','https://example.com/#room']){
    assert.throws(()=>makeCloudflareConfig({...base,ALLOWED_ORIGINS:value}),/ALLOWED_ORIGINS/);
  }
});

test('deployment configuration never includes environment credentials',()=>{
  const config=makeCloudflareConfig({...base,CLOUDFLARE_API_TOKEN:'DO_NOT_WRITE_THIS',CLOUDFLARE_ACCOUNT_ID:'secret-account',UNRELATED_SECRET:'hidden'});
  assert.doesNotMatch(JSON.stringify(config),/DO_NOT_WRITE_THIS|secret-account|hidden|API_TOKEN/);
});
