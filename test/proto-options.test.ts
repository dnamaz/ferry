import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadProtoFiles } from '../src/grpc/proto-files.js';
import { Schema } from '../src/grpc/schema.js';

const tmp: string[] = [];
afterEach(() => tmp.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('.proto files that extend descriptor options (buf/validate, google/api)', () => {
  it('loads: protobufjs-injected extension fields do not create an import cycle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ferry-opts-'));
    tmp.push(dir);
    // The shape of buf/validate/validate.proto: an options package extending FieldOptions.
    writeFileSync(join(dir, 'rules.proto'), `syntax = "proto3";
package demo.rules;
import "google/protobuf/descriptor.proto";
message FieldRules { bool required = 1; }
extend google.protobuf.FieldOptions { FieldRules field = 1159; }
`);
    writeFileSync(join(dir, 'svc.proto'), `syntax = "proto3";
package demo.svc;
import "rules.proto";
import "google/protobuf/timestamp.proto";
message Req { string tenant_id = 1 [(demo.rules.field).required = true]; google.protobuf.Timestamp at = 2; }
message Res { string id = 1; }
service Reports { rpc ListReports(Req) returns (Res); }
`);
    const schema = new Schema(await loadProtoFiles([join(dir, 'svc.proto')], [dir]));
    expect(schema.findMethod('/demo.svc.Reports/ListReports')).toBeDefined();
    expect(schema.findMethod('/demo.svc.Reports/ListReports')!.desc.input.fields.map((f) => f.name)).toEqual(['tenant_id', 'at']);
  });
});

describe('.proto files whose packages import each other through different files', () => {
  it('loads: descriptors keep the real files, so the packages do not form an import cycle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ferry-pkgs-'));
    tmp.push(dir);
    // a/common.proto <- b/sync.proto <- a/entities.proto: acyclic as files, a cycle as packages.
    writeFileSync(join(dir, 'common.proto'), `syntax = "proto3";
package demo.a;
enum Kind { KIND_UNSPECIFIED = 0; KIND_COMPANY = 1; }
`);
    writeFileSync(join(dir, 'sync.proto'), `syntax = "proto3";
package demo.b;
import "common.proto";
message Sync { demo.a.Kind kind = 1; }
`);
    writeFileSync(join(dir, 'entities.proto'), `syntax = "proto3";
package demo.a;
import "sync.proto";
message Company { string id = 1; demo.b.Sync sync = 2; }
service Companies { rpc Get(Company) returns (Company); }
`);
    const schema = new Schema(await loadProtoFiles([join(dir, 'entities.proto')], [dir]));
    const method = schema.findMethod('/demo.a.Companies/Get');
    expect(method).toBeDefined();
    expect(method!.desc.input.fields.map((f) => f.name)).toEqual(['id', 'sync']);
  });
});
