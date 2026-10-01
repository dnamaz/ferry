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
