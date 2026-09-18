import { describe, expect, test } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Kbd } from '../components/ui/kbd';
import { NativeSelect, NativeSelectOption } from '../components/ui/native-select';

describe('probe', () => {
  test('base-ui primitives render to static markup', () => {
    const html = renderToStaticMarkup(
      h('div', null,
        h(Badge, { variant: 'secondary' }, 'x2'),
        h(Button, { size: 'xs' }, 'Play'),
        h(Input, { value: 'a', readOnly: true }),
        h(Kbd, null, 'F'),
        h(NativeSelect, { value: '1', onChange: () => {} }, h(NativeSelectOption, { value: '1' }, 'one')),
      ),
    );
    console.log(html);
    expect(html).toContain('x2');
  });
});
