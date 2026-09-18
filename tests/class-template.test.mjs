import assert from 'node:assert/strict';
import { renderCppClass } from '../src/class-template.ts';

const generated = renderCppClass('NewClass', 'src/NewClass.h', 'Archius', new Date(2026, 8, 18));

assert.equal(generated.sourceContent, [
  '/*',
  ' * NewClass.cpp',
  ' *',
  ' *  Created on: Sep 18, 2026',
  ' *      Author: Archius',
  ' */',
  '',
  '#include "NewClass.h"',
  '',
  'NewClass::NewClass() {',
  '\t// TODO Auto-generated constructor stub',
  '',
  '}',
  '',
  'NewClass::~NewClass() {',
  '\t// TODO Auto-generated destructor stub',
  '}',
  '',
].join('\n'));

assert.equal(generated.headerContent, [
  '/*',
  ' * NewClass.h',
  ' *',
  ' *  Created on: Sep 18, 2026',
  ' *      Author: Archius',
  ' */',
  '',
  '#ifndef SRC_NEWCLASS_H_',
  '#define SRC_NEWCLASS_H_',
  '',
  'class NewClass {',
  'public:',
  '\tNewClass();',
  '\tvirtual ~NewClass();',
  '};',
  '',
  '#endif /* SRC_NEWCLASS_H_ */',
  '',
].join('\n'));

console.log('C++ class template tests passed.');
