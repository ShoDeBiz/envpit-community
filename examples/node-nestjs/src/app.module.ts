import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { validateConfig } from './config.schema';

// Plain, idiomatic Nest boilerplate -- exactly what `nest generate module` would produce plus
// one `validate` option. Nothing here is special-cased for EnvPit; that is the point. See
// main.ts for why THIS FILE must not be imported until after EnvPit's process.env merge runs.
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateConfig,
    }),
  ],
  controllers: [AppController],
})
export class AppModule {}
